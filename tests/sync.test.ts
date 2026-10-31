import "fake-indexeddb/auto";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { openRecallRepository, openAccountRecallRepository, createSyncEngine, createSupabaseSyncTransport, type SyncTransport } from "../packages/api-client/src/index.ts";
import { parseBackup, type Note, type SyncPushResult, type SyncPullResult } from "../packages/core/src/index.ts";
import { createTestDatabase } from "./helpers/database.ts";
let database: Awaited<ReturnType<typeof createTestDatabase>>;
before(async () => {
    database = await createTestDatabase();
});
after(async () => {
    await database.close();
});
const named = () => `sync-test-${crypto.randomUUID()}`;
function transport(userId: string, pageSize = 100): SyncTransport {
    // Exercise the production JSON validator against the real PostgreSQL migration.
    return createSupabaseSyncTransport({
        async rpc(name, args) {
            try {
                if (name === "apply_sync_operation")
                    return {
                        data: await database.apply(userId, args.p_operation), error: null
                    };
                if (name === "pull_suite_changes")
                    return {
                        data: await database.pullSuite(userId, String(args.p_cursor), Math.min(Number(args.p_limit), pageSize)), error: null
                    };
                if (name === "pull_tools_changes")
                    return {
                        data: await database.pullTools(userId, String(args.p_cursor), Math.min(Number(args.p_limit), pageSize)), error: null
                    };
                throw new Error("Unknown application RPC");
            }
            catch (error) {
                return {
                    data: null, error: {
                        message: error instanceof Error ? error.message : String(error)
                    }
                };
            }
        }
    }, userId);
}
async function device(userId: string, name = named()) {
    return openAccountRecallRepository(userId, {
        name
    });
}
async function sync(repo: Awaited<ReturnType<typeof device>>, via = transport(repo.ownerId)) {
    const engine = createSyncEngine(repo, via);
    const state = await engine.run();
    engine.stop();
    assert.equal(state.phase, "idle", state.error);
    return state;
}
const gate = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
        resolve = done;
    });
    return {
        promise, resolve
    };
};
test("v1端末DBを移行してメモと下書きを保持する", async () => {
    const name = named();
    const note: Note = {
        id: crypto.randomUUID(), kind: "note", originApp: "recall", ownerId: null, body: "移行前のメモ", spaceIds: ["daily"], pinned: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null, localRevision: 1, serverRevision: null
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name, 1);
        req.onupgradeneeded = () => {
            for (const store of ["notes", "spaces", "outbox", "drafts"])
                req.result.createObjectStore(store, {
                    keyPath: "id"
                });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    const tx = db.transaction(["notes", "spaces", "drafts", "outbox"], "readwrite");
    const done = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    tx.objectStore("notes").put(note);
    tx.objectStore("spaces").put({
        id: "daily", name: "日常", color: "#729379", createdAt: note.createdAt
    });
    tx.objectStore("drafts").put({
        id: "composer", body: "書きかけ", spaceIds: ["daily"]
    });
    tx.objectStore("outbox").put({
        id: note.id, entityId: note.id, operation: "put_note", payload: note,
        baseRevision: null, createdAt: note.updatedAt, state: "local_only",
    });
    await done;
    db.close();
    const repo = await openRecallRepository(name);
    assert.equal((await repo.snapshot()).notes[0].body, "移行前のメモ");
    assert.equal((await repo.loadDraft()).body, "書きかけ");
    repo.close();
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name, 4);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    const originalIntent = await new Promise<{payload:Note}>((resolve, reject) => {
        const req = upgraded.transaction("outbox", "readonly").objectStore("outbox").get(note.id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    assert.equal(originalIntent.payload.body, "移行前のメモ");
    upgraded.close();
});
test("2端末で新規・編集・削除・復元と任意スペースを同期する", async () => {
    const user = await database.addUser();
    const a = await device(user), b = await device(user);
    await sync(a);
    await sync(b);
    assert.equal((await a.getSyncState()).conflicts.length, 0);
    const space = await a.createSpace("旅行");
    let note = await a.saveNote({
        body: "端末Aで記録", spaceIds: [space.id]
    });
    await sync(a);
    await sync(b);
    let other = (await b.snapshot()).notes[0];
    assert.equal(other.body, "端末Aで記録");
    assert.equal((await b.snapshot()).spaces.find(s => s.id === space.id)?.name, "旅行");
    other = await b.saveNote({
        ...other, body: "端末Bで編集"
    }, other.localRevision);
    await sync(b);
    await sync(a);
    note = (await a.snapshot()).notes[0];
    assert.equal(note.body, "端末Bで編集");
    note = await a.saveNote({
        ...note, deletedAt: new Date().toISOString()
    }, note.localRevision);
    await sync(a);
    await sync(b);
    other = (await b.snapshot()).notes[0];
    assert.ok(other.deletedAt);
    await b.saveNote({
        ...other, deletedAt: null
    }, other.localRevision);
    await sync(b);
    await sync(a);
    assert.equal((await a.snapshot()).notes[0].deletedAt, null);
    a.close();
    b.close();
});
test("通信結果不明でも同じoperation IDを再送して重複しない", async () => {
    const user = await database.addUser(), name = named();
    let repo = await device(user, name);
    await sync(repo);
    const note = await repo.saveNote({
        body: "応答だけ失われる", spaceIds: ["daily"]
    });
    const base = transport(user);
    let failed = false;
    const sent: string[] = [];
    const unreliable: SyncTransport = {
        userId: user, pull: base.pull, push: async (op) => {
            sent.push(op.id);
            const result = await base.push(op);
            if (!failed) {
                failed = true;
                throw new Error("Network reply lost");
            }
            return result;
        }
    };
    const engine = createSyncEngine(repo, unreliable);
    assert.equal((await engine.run()).phase, "error");
    assert.equal((await repo.getSyncState()).pending, 1);
    const queued = (await repo.pendingOperations())[0];
    engine.stop();
    repo.close();
    repo = await device(user, name);
    await sync(repo, unreliable);
    assert.deepEqual(sent, [queued.id, queued.id]);
    const remote = await database.queryAs(user, "select id from public.items where id=$1", [note.id]);
    assert.equal(remote.rows.length, 1);
    assert.equal((await repo.getSyncState()).pending, 0);
    repo.close();
});
test("オフラインの連続編集をpredecessor順に適用して自身の競合を作らない", async () => {
    const user = await database.addUser();
    const repo = await device(user);
    await sync(repo);
    let note = await repo.saveNote({
        body: "下書き1", spaceIds: ["daily"]
    });
    note = await repo.saveNote({
        ...note, body: "下書き2"
    }, note.localRevision);
    note = await repo.saveNote({
        ...note, body: "最終版"
    }, note.localRevision);
    const ops = await repo.pendingOperations();
    assert.equal(ops.length, 3);
    assert.equal(ops[1].previousOperationId, ops[0].id);
    assert.equal(ops[2].previousOperationId, ops[1].id);
    await sync(repo);
    const state = await repo.getSyncState();
    assert.equal(state.conflicts.length, 0);
    assert.equal((await repo.snapshot()).notes[0].body, "最終版");
    assert.equal((await repo.snapshot()).notes[0].serverRevision, 3);
    repo.close();
});
test("送信中に編集しても古いackで最新本文を上書きしない", async () => {
    const user = await database.addUser();
    const repo = await device(user);
    await sync(repo);
    let note = await repo.saveNote({
        body: "送信中の版", spaceIds: []
    });
    const base = transport(user), started = gate(), release = gate();
    let held = false;
    const delayed: SyncTransport = {
        userId: user, pull: base.pull, push: async (op) => {
            const result = await base.push(op);
            if (op.kind === "put_note" && !held) {
                held = true;
                started.resolve();
                await release.promise;
            }
            return result;
        }
    };
    const engine = createSyncEngine(repo, delayed);
    const run = engine.run();
    await started.promise;
    note = await repo.saveNote({
        ...note, body: "送信中に追記した最終版"
    }, note.localRevision);
    release.resolve();
    const result = await run;
    assert.equal(result.phase, "idle", result.error);
    assert.equal((await repo.snapshot()).notes[0].body, "送信中に追記した最終版");
    assert.equal((await repo.snapshot()).notes[0].serverRevision, 2);
    engine.stop();
    repo.close();
});
test("競合は両方を保持し、端末の最新編集を別メモとして残せる", async () => {
    const user = await database.addUser();
    const a = await device(user), b = await device(user);
    await sync(a);
    const original = await a.saveNote({
        body: "原本", spaceIds: ["daily"]
    });
    await sync(a);
    await sync(b);
    const fromA = (await a.snapshot()).notes[0];
    await a.saveNote({
        ...fromA, body: "Aの確定版"
    }, fromA.localRevision);
    await sync(a);
    let fromB = (await b.snapshot()).notes[0];
    fromB = await b.saveNote({
        ...fromB, body: "Bの編集中"
    }, fromB.localRevision);
    await b.saveNote({
        ...fromB, body: "Bの最新編集"
    }, fromB.localRevision);
    const engine = createSyncEngine(b, transport(user));
    assert.equal((await engine.run()).phase, "conflict");
    const state = await b.getSyncState();
    assert.equal(state.pending, 0);
    assert.equal(state.conflicts.length, 1);
    assert.equal((state.conflicts[0].local as Note).body, "Bの最新編集");
    assert.equal((state.conflicts[0].remote as Note).body, "Aの確定版");
    await b.resolveConflict(state.conflicts[0].id, "keep_both");
    assert.equal((await engine.run()).phase, "idle");
    await sync(a);
    const all = (await a.snapshot()).notes;
    assert.equal(all.length, 2);
    assert.equal(all.find(n => n.id === original.id)?.body, "Aの確定版");
    assert.ok(all.some(n => n.body === "Bの最新編集"));
    engine.stop();
    a.close();
    b.close();
});
test("差分を複数ページ取得し、古い差分で新しい本文を上書きしない", async () => {
    const user = await database.addUser();
    const a = await device(user), b = await device(user);
    await sync(a);
    for (let i = 0; i < 7; i++)
        await a.saveNote({
            body: `メモ${i}`, spaceIds: []
        });
    await sync(a);
    const base = transport(user, 2);
    let pages = 0;
    await sync(b, {
        userId: user, push: base.push, pull: async (...args) => {
            pages++;
            return base.pull(...args);
        }
    });
    assert.ok(pages >= 5);
    assert.equal((await b.snapshot()).notes.length, 7);
    const old = await database.pull(user, "0", 100);
    const note = (await b.snapshot()).notes[0];
    await b.saveNote({
        ...note, body: "古い差分より新しい"
    }, note.localRevision);
    await sync(b);
    await b.acceptPull({
        ...old, cursor: (await b.getSyncState()).cursor
    } as SyncPullResult);
    assert.equal((await b.snapshot()).notes.find(n => n.id === note.id)?.body, "古い差分より新しい");
    a.close();
    b.close();
});
test("アカウント変更でlate replyを適用せず、再起動後の再送は安全", async () => {
    const user = await database.addUser(), other = await database.addUser(), name = named();
    const repo = await device(user, name);
    await sync(repo);
    const note = await repo.saveNote({
        body: "Aだけのメモ", spaceIds: []
    });
    const base = transport(user), started = gate(), release = gate();
    const delayed: SyncTransport = {
        userId: user, pull: base.pull, push: async (op) => {
            const result = await base.push(op);
            started.resolve();
            await release.promise;
            return result;
        }
    };
    const engine = createSyncEngine(repo, delayed);
    const flight = engine.run();
    await started.promise;
    engine.stop();
    repo.close();
    const b = await device(other);
    release.resolve();
    assert.equal((await flight).phase, "stopped");
    assert.equal((await b.snapshot()).notes.length, 0);
    const reopened = await device(user, name);
    assert.equal((await reopened.getSyncState()).pending, 1);
    await sync(reopened);
    assert.equal((await reopened.snapshot()).notes[0].id, note.id);
    assert.equal((await reopened.getSyncState()).pending, 0);
    assert.throws(() => createSyncEngine(reopened, transport(other)), /アカウント/);
    await assert.rejects(openAccountRecallRepository(other, {
        name
    }), /別のアカウント/);
    reopened.close();
    b.close();
});
test("取り込みは明示操作でのみ行い、原本を保持したportable backupを作る", async () => {
    const source = await openRecallRepository();
    await source.saveDraft("端末にだけ残す下書き", []);
    const original = await source.saveNote({
        body: "端末だけの原本", spaceIds: ["creative"]
    });
    const user = await database.addUser();
    const account = await device(user);
    assert.equal((await account.snapshot()).notes.length, 0);
    const count = await account.importDeviceData();
    assert.equal(count.notes, 1);
    assert.equal((await source.snapshot()).notes[0].id, original.id);
    const imported = (await account.snapshot()).notes[0];
    assert.notEqual(imported.id, original.id);
    assert.equal(imported.ownerId, user);
    await sync(account);
    const backup = parseBackup(await account.exportBackup());
    assert.equal(backup.notes[0].ownerId, null);
    assert.equal(backup.notes[0].serverRevision, null);
    const local = await openRecallRepository(named());
    await local.importBackup(backup);
    assert.equal((await local.snapshot()).notes[0].body, "端末だけの原本");
    source.close();
    account.close();
    local.close();
});
test("別userの応答と不正なRPC結果を永続化しない", async () => {
    const user = await database.addUser(), other = await database.addUser();
    const repo = await device(user);
    await sync(repo);
    const note = await repo.saveNote({
        body: "本人の本文", spaceIds: []
    });
    const op = (await repo.pendingOperations())[0];
    await assert.rejects(repo.acceptPush(op, {
        status: "applied", operationId: op.id, record: {
            ...note, ownerId: other, serverRevision: 1
        }
    }), /アカウント/);
    assert.equal((await repo.getSyncState()).pending, 1);
    const bad = createSupabaseSyncTransport({
        async rpc() {
            return {
                data: {
                    status: "applied", operationId: op.id, record: {
                        ...note, ownerId: other, serverRevision: 1
                    }
                }, error: null
            };
        }
    }, user);
    await assert.rejects(bad.push(op), /検証/);
    repo.close();
});
