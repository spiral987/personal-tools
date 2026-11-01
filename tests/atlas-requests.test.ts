import "fake-indexeddb/auto";
import test, {type TestContext} from "node:test";
import assert from "node:assert/strict";
import {openRecallRepository, openAccountRecallRepository} from "../packages/api-client/src/repository.ts";
import {createVault, lockVault, unlockVault} from "../packages/api-client/src/vault.ts";

async function device(t: TestContext, name = `test-atlas-requests-${crypto.randomUUID()}`) {
    const repo = await openRecallRepository(name);
    t.after(() => repo.close());
    return repo;
}

test("Atlas requests: explicit setup binds one existing space, persists across reopening, and rejects other spaces", async t => {
    const name = `test-atlas-requests-${crypto.randomUUID()}`, repo = await device(t, name);
    const target = await repo.createSpace("Atlas要望");
    await repo.saveNote({body: "未設定なら出力しない", spaceIds: [target.id]});
    assert.equal(await repo.loadAtlasRequestSharing(), null);
    await assert.rejects(repo.exportAtlasRequests(), /共有元を先に設定/);
    await assert.rejects(repo.prepareAtlasRequestSharing("daily"), /Atlas要望スペースだけ/);
    assert.equal(await repo.loadAtlasRequestSharing(), null);
    const sharing = await repo.prepareAtlasRequestSharing();
    assert.equal(sharing.spaceId, target.id);
    assert.notEqual(sharing.shareId, target.id);
    assert.deepEqual(await repo.prepareAtlasRequestSharing(), sharing);
    const reopened = await device(t, name);
    assert.deepEqual(await reopened.loadAtlasRequestSharing(), sharing);
    assert.equal((await reopened.snapshot()).spaces.filter(space => space.name === "Atlas要望").length, 1);
});

test("Atlas requests: only selected live note bodies, IDs and update times cross the export boundary", async t => {
    const repo = await device(t), sharing = await repo.prepareAtlasRequestSharing();
    const privateSpace = await repo.createSpace("共有しないスペース名");
    const selected = await repo.saveNote({body: "検索を改善したい", spaceIds: [sharing.spaceId, privateSpace.id], pinned: true});
    const privateNote = await repo.saveNote({body: "絶対に含めない別スペースの本文", spaceIds: [privateSpace.id]});
    const trashed = await repo.saveNote({body: "絶対に含めないごみ箱の本文", spaceIds: [sharing.spaceId]});
    await repo.saveNote({...trashed, deletedAt: new Date().toISOString()}, trashed.localRevision);
    await repo.saveDraft("絶対に含めない下書き", [sharing.spaceId]);
    await repo.saveRecallEditDraft({noteId: selected.id, body: "絶対に含めない編集中の本文", spaceIds: [sharing.spaceId], revision: selected.localRevision});
    await repo.saveSketch({title: "絶対に含めない関連スケッチ", strokes: [], spaceIds: [sharing.spaceId]});
    await repo.saveRelation({fromItemId: selected.id, toItemId: privateNote.id, type: "related_to"});
    await repo.saveLabels(selected.id, ["絶対に含めないタグ"]);
    const data = await repo.exportAtlasRequests();
    assert.deepEqual(Object.keys(data).sort(), ["exportedAt", "format", "mode", "notes", "scope", "shareId", "version"]);
    assert.equal(data.format, "personal-tools.atlas-requests");
    assert.equal(data.mode, "snapshot");
    assert.equal(data.scope, "Atlas要望");
    assert.equal(data.shareId, sharing.shareId);
    assert.deepEqual(data.notes, [{id: selected.id, body: selected.body, updatedAt: selected.updatedAt}]);
    const encoded = JSON.stringify(data);
    for (const forbidden of ["絶対に含めない", privateSpace.name, privateSpace.id, privateNote.id, sharing.spaceId, "ownerId", "spaceIds", "sealed", "vault", "recovery", "ciphertext"])
        assert.ok(!encoded.includes(forbidden), forbidden);
    assert.equal((await repo.loadDraft()).body, "絶対に含めない下書き");
});

test("Atlas requests: each snapshot reflects updates, removals and trash restoration with stable management IDs", async t => {
    const repo = await device(t), sharing = await repo.prepareAtlasRequestSharing();
    const first = await repo.saveNote({body: "初版の本文", spaceIds: [sharing.spaceId]});
    const removed = await repo.saveNote({body: "共有から外す", spaceIds: [sharing.spaceId]});
    const trashed = await repo.saveNote({body: "ごみ箱へ移す", spaceIds: [sharing.spaceId]});
    const before = await repo.exportAtlasRequests();
    const updated = await repo.saveNote({...first, body: "最新版の本文"}, first.localRevision);
    await repo.saveNote({...removed, spaceIds: ["daily"]}, removed.localRevision);
    const deleted = await repo.saveNote({...trashed, deletedAt: new Date().toISOString()}, trashed.localRevision);
    const after = await repo.exportAtlasRequests();
    assert.equal(after.shareId, before.shareId);
    assert.deepEqual(after.notes, [{id: first.id, body: updated.body, updatedAt: updated.updatedAt}]);
    assert.ok(!JSON.stringify(after).includes("初版の本文"));
    assert.deepEqual(before.notes.filter(note => !after.notes.some(current => current.id === note.id)).map(note => note.id).sort(), [removed.id, trashed.id].sort());
    await repo.saveNote({...deleted, deletedAt: null}, deleted.localRevision);
    assert.deepEqual((await repo.exportAtlasRequests()).notes.map(note => note.id).sort(), [first.id, trashed.id].sort());
    await repo.saveNote({...updated, spaceIds: []}, updated.localRevision);
    const restored = (await repo.snapshot()).notes.find(note => note.id === trashed.id)!;
    await repo.saveNote({...restored, spaceIds: []}, restored.localRevision);
    assert.deepEqual((await repo.exportAtlasRequests()).notes, []);
});

test("Atlas requests: duplicate names require an explicit ID and never expand the allowed space", async t => {
    const repo = await device(t), original = await repo.createSpace("Atlas要望");
    const originalNote = await repo.saveNote({body: "設定したスペース", spaceIds: [original.id]});
    await repo.importBackup(await repo.exportBackup());
    const spaces = (await repo.snapshot()).spaces.filter(space => space.name === "Atlas要望");
    const duplicate = spaces.find(space => space.id !== original.id)!;
    await assert.rejects(repo.prepareAtlasRequestSharing(), /複数/);
    const sharing = await repo.prepareAtlasRequestSharing(original.id);
    assert.deepEqual((await repo.exportAtlasRequests()).notes.map(note => note.id), [originalNote.id]);
    await assert.rejects(repo.prepareAtlasRequestSharing(duplicate.id), /先に.*解除/);
    assert.deepEqual(await repo.loadAtlasRequestSharing(), sharing);
    await repo.disableAtlasRequestSharing();
    assert.equal(await repo.loadAtlasRequestSharing(), null);
    await assert.rejects(repo.exportAtlasRequests(), /共有元を先に設定/);
    assert.equal((await repo.snapshot()).notes.length, 2);
    const next = await repo.prepareAtlasRequestSharing(duplicate.id);
    assert.notEqual(next.shareId, sharing.shareId);
    assert.equal((await repo.exportAtlasRequests()).notes.length, 1);
});

test("Atlas requests: a renamed or missing bound space never causes lookup by name on export", async t => {
    const name = `test-atlas-requests-${crypto.randomUUID()}`, repo = await device(t, name);
    const sharing = await repo.prepareAtlasRequestSharing();
    const selected = await repo.saveNote({body: "固定IDのメモ", spaceIds: [sharing.spaceId]});
    const {encryptedTransaction} = await import("../packages/api-client/src/vault-idb.ts");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    t.after(() => db.close());
    const space = (await repo.snapshot()).spaces.find(space => space.id === sharing.spaceId)!;
    const write = (work: (store: IDBObjectStore) => void) => new Promise<void>((resolve, reject) => {
        const tx = encryptedTransaction(db, ["spaces"], "readwrite");
        tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
        work(tx.objectStore("spaces"));
    });
    await write(store => {store.put({...space, name: "名前を変えても共有元は同じ"});});
    const decoy = await repo.createSpace("Atlas要望");
    await repo.saveNote({body: "同名でも共有してはいけない", spaceIds: [decoy.id]});
    assert.deepEqual((await repo.exportAtlasRequests()).notes.map(note => note.id), [selected.id]);
    await write(store => {store.delete(sharing.spaceId);});
    await assert.rejects(repo.exportAtlasRequests(), /共有元のスペースが見つかりません/);
    await assert.rejects(repo.prepareAtlasRequestSharing(), /共有元のスペースが見つかりません/);
    assert.equal((await repo.loadAtlasRequestSharing())?.spaceId, sharing.spaceId);
});

test("Atlas requests: sharing configuration is ciphertext at rest and setup rolls back atomically", async t => {
    const name = `test-atlas-requests-${crypto.randomUUID()}`, repo = await device(t, name);
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
        if (this.name === "meta") throw new DOMException("test failure", "QuotaExceededError");
        return original.apply(this, args);
    };
    try {await assert.rejects(repo.prepareAtlasRequestSharing());}
    finally {IDBObjectStore.prototype.put = original;}
    assert.equal(await repo.loadAtlasRequestSharing(), null);
    assert.ok(!(await repo.snapshot()).spaces.some(space => space.name === "Atlas要望"));
    const sharing = await repo.prepareAtlasRequestSharing();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    t.after(() => db.close());
    const rows = await new Promise<unknown[]>((resolve, reject) => {
        const request = db.transaction("meta").objectStore("meta").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    for (const row of rows) assert.deepEqual(Object.keys(row as object).sort(), ["id", "sealed", "vault"]);
    for (const secret of [sharing.spaceId, sharing.shareId, "atlas-request-sharing"]) assert.ok(!JSON.stringify(rows).includes(secret));
});

test("Atlas requests: sharing stays scoped to each account and device and queues only a new space for sync", async t => {
    const ownerA = "11111111-1111-4111-8111-111111111111", ownerB = "22222222-2222-4222-8222-222222222222";
    const a = await openAccountRecallRepository(ownerA, {name: `test-atlas-requests-account-a-${crypto.randomUUID()}`});
    const b = await openAccountRecallRepository(ownerB, {name: `test-atlas-requests-account-b-${crypto.randomUUID()}`});
    t.after(() => {a.close(); b.close();});
    const before = (await a.pendingOperations()).length, sharing = await a.prepareAtlasRequestSharing();
    const pending = await a.pendingOperations();
    assert.equal(pending.length, before + 1);
    assert.ok(pending.some(operation => operation.kind === "put_space" && operation.entityId === sharing.spaceId));
    assert.ok(!JSON.stringify(pending).includes(sharing.shareId));
    assert.equal(await b.loadAtlasRequestSharing(), null);
    await assert.rejects(b.exportAtlasRequests(), /共有元を先に設定/);
    const source = await a.saveNote({body: "アカウントAだけの要望", spaceIds: [sharing.spaceId]});
    assert.deepEqual((await a.exportAtlasRequests()).notes, [{id: source.id, body: source.body, updatedAt: source.updatedAt}]);
    const otherDevice = await device(t);
    assert.equal(await otherDevice.loadAtlasRequestSharing(), null);
});

test("Atlas requests: a locked vault cannot export or prepare sharing, and unlocking restores the binding", async t => {
    const passphrase = "atlas-request-test-only-long-passphrase", {descriptor} = await createVault(passphrase);
    const name = `test-atlas-requests-${crypto.randomUUID()}`, repo = await device(t, name);
    const sharing = await repo.prepareAtlasRequestSharing();
    await repo.saveNote({body: "解錠したときだけ読める要望", spaceIds: [sharing.spaceId]});
    const inFlight = repo.exportAtlasRequests();
    lockVault();
    await assert.rejects(inFlight);
    await assert.rejects(repo.exportAtlasRequests());
    await assert.rejects(repo.prepareAtlasRequestSharing());
    await assert.rejects(repo.loadAtlasRequestSharing());
    await assert.rejects(repo.disableAtlasRequestSharing());
    await unlockVault(descriptor, passphrase);
    const reopened = await device(t, name);
    assert.deepEqual(await reopened.loadAtlasRequestSharing(), sharing);
    assert.equal((await reopened.exportAtlasRequests()).notes.length, 1);
});
