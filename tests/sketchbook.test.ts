import "fake-indexeddb/auto";
import test, { before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { openRecallRepository, openAccountRecallRepository, createSyncEngine, createSupabaseSyncTransport,
    uploadSketchPreview, downloadSketchPreview, type SketchPreviewClient, type AccountRecallRepository } from "../packages/api-client/src/index.ts";
import { parseSketchStrokes, parseSketchSpaceIds, parseSketchBackup, jsonbByteLength, assertSketchSyncBudget, type SketchStroke } from "../packages/core/src/index.ts";
import { createTestDatabase } from "./helpers/database.ts";
import {shouldRestoreSketchDraft} from "../apps/sketchbook/app/draft-recovery.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
before(async () => { database = await createTestDatabase(); });
after(async () => { await database.close(); });
const strokes = (x = 20): SketchStroke[] => [{ id: crypto.randomUUID(), tool: "pen", color: "#243449", width: 4, points: [{ x, y: 30, pressure: 0.5 }, { x: x + 10, y: 40, pressure: 0.6 }] }];
const name = () => `sketch-test-${crypto.randomUUID()}`;
test("Sketchbook: unsaved source-note association survives tool navigation and reopening",async()=>{
    const dbName=name(),repo=await openRecallRepository(dbName),sourceNoteId=crypto.randomUUID();
    const saved=await repo.saveSketch({title:"未保存の描画",strokes:strokes(),spaceIds:[]});
    const draft={title:saved.title,strokes:saved.strokes,spaceIds:saved.spaceIds,editingId:saved.id,expectedRevision:saved.localRevision};
    assert.equal(shouldRestoreSketchDraft(draft,saved),false);
    await repo.saveSketchDraft({...draft,sourceNoteId});
    repo.close();const reopened=await openRecallRepository(dbName);
    try{
        assert.equal((await reopened.loadSketchDraft()).sourceNoteId,sourceNoteId);
        assert.equal(shouldRestoreSketchDraft(await reopened.loadSketchDraft(),saved),true,"Unsaved association must take priority over another original link");
        await assert.rejects(reopened.saveSketchDraft({title:"拒否する版",strokes:[],spaceIds:[],sourceNoteId:"invalid"}));
        assert.equal((await reopened.loadSketchDraft()).title,"未保存の描画");
    }finally{reopened.close();}
});
async function device(t: TestContext, ownerId: string) {
    const repo = await openAccountRecallRepository(ownerId, { name: name() }); t.after(() => repo.close()); return repo;
}
function transport(ownerId: string) {
    return createSupabaseSyncTransport({ async rpc(method, args) {
        try {
            return { data: method === "apply_sync_operation" ? await database.apply(ownerId, args.p_operation)
                : await database.pullAtlas(ownerId, String(args.p_cursor), Number(args.p_limit)), error: null };
        } catch (error) { return { data: null, error: { message: String(error) } }; }
    } }, ownerId);
}
async function sync(repo: AccountRecallRepository, expected = "idle") {
    const engine = createSyncEngine(repo, transport(repo.ownerId));
    try { const state = await engine.run(); assert.equal(state.phase, expected, state.error); return state; } finally { engine.stop(); }
}

test("Sketchbook: original strokes, draft editing revision, and Recall relation survive reopening without note duplication", async t => {
    const dbName = name(), repo = await openRecallRepository(dbName);
    const note = await repo.saveNote({ body: "散歩で見た建物", spaceIds: ["daily"] });
    const drawing = await repo.saveSketch({ title: "構図", strokes: strokes(), spaceIds: ["creative"] });
    await repo.saveSketchDraft({ title: "編集中", strokes: strokes(40), spaceIds: [], editingId: drawing.id, expectedRevision: drawing.localRevision });
    const relation = await repo.saveRelation({ fromItemId: drawing.id, toItemId: note.id, type: "inspired_by" });
    assert.equal((await repo.saveRelation({ fromItemId: drawing.id, toItemId: note.id, type: "inspired_by" })).id, relation.id);
    repo.close();
    const restored = await openRecallRepository(dbName); t.after(() => restored.close());
    const data = await restored.snapshot(); assert.equal(data.notes.length, 1); assert.equal(data.sketches.length, 1);
    assert.deepEqual(data.sketches[0].strokes, drawing.strokes); assert.equal(data.relations[0].toItemId, note.id);
    assert.equal((await restored.loadSketchDraft()).expectedRevision, drawing.localRevision);
    const changed = await restored.updateSketch(drawing.id, { title: "新しい題" }, drawing.localRevision);
    await assert.rejects(restored.saveSketch({ ...drawing, title: "古い画面" }, drawing.localRevision), /別の画面/);
    await restored.deleteRelation(relation.id, relation.localRevision);
    assert.ok((await restored.snapshot()).relations[0].deletedAt); assert.equal(changed.localRevision, 2);
});

test("Sketchbook: invalid geometry and broken backup cannot alter existing drawings", async t => {
    const repo = await openRecallRepository(name()); t.after(() => repo.close());
    const drawing = await repo.saveSketch({ title: "原本", strokes: strokes(), spaceIds: [] });
    await assert.rejects(repo.saveSketch({ title: "壊れた描画", strokes: [{ ...strokes()[0], points: [{ x: Infinity, y: 0, pressure: 1 }] }], spaceIds: [] }));
    assert.throws(() => parseSketchStrokes([{ ...strokes()[0], points: [{ x: 1201, y: 0, pressure: 1 }] }]));
    assert.throws(() => parseSketchStrokes([{ ...strokes()[0], width: 100 }]));
    const backup = await repo.exportSketchBackup();
    await assert.rejects(repo.importSketchBackup({ ...backup, sketches: [{ ...backup.sketches[0], spaceIds: ["not-present"] }] }));
    assert.equal((await repo.snapshot()).sketches.length, 1);
    const result = await repo.importSketchBackup(backup); assert.equal(result.sketches, 1);
    const data = await repo.snapshot(); assert.equal(data.sketches.length, 2); assert.ok(data.sketches.some(sketch => sketch.id !== drawing.id));
    assert.equal(parseSketchBackup(backup).sketches[0].ownerId, null);
});

test("Sketchbook SQL: two independent caches sync sketches, source links, deletion and restoration", async t => {
    const owner = await database.addUser(), a = await device(t, owner), b = await device(t, owner);
    const note = await a.saveNote({ body: "Recallの着想", spaceIds: ["daily"] });
    let drawing = await a.saveSketch({ title: "スケッチ", strokes: strokes(), spaceIds: ["creative"] });
    const relation = await a.saveRelation({ fromItemId: drawing.id, toItemId: note.id, type: "inspired_by" });
    await sync(a); await sync(b);
    let data = await b.snapshot(); assert.equal(data.notes.length, 1); assert.equal(data.sketches.length, 1); assert.equal(data.relations[0].toItemId, note.id);
    drawing = data.sketches[0]; drawing = await b.updateSketch(drawing.id, { deletedAt: new Date().toISOString() }, drawing.localRevision); await sync(b); await sync(a);
    assert.ok((await a.snapshot()).sketches[0].deletedAt);
    await b.updateSketch(drawing.id, { deletedAt: null }, drawing.localRevision); await sync(b); await sync(a);
    assert.equal((await a.snapshot()).sketches[0].deletedAt, null);
    const remoteRelation = (await b.snapshot()).relations.find(link => link.id === relation.id)!;
    await b.deleteRelation(remoteRelation.id, remoteRelation.localRevision); await sync(b); await sync(a);
    assert.ok((await a.snapshot()).relations[0].deletedAt);
    assert.equal((await a.snapshot()).notes[0].id, note.id);
});

test("Sketchbook SQL: offline chains replay once and concurrent edits keep the newest local original in backup", async t => {
    const owner = await database.addUser(), a = await device(t, owner), b = await device(t, owner);
    let drawing = await a.saveSketch({ title: "初版", strokes: strokes(), spaceIds: [] });
    drawing = await a.updateSketch(drawing.id, { title: "オフライン2", strokes: strokes(60) }, drawing.localRevision);
    drawing = await a.updateSketch(drawing.id, { title: "オフライン3" }, drawing.localRevision);
    await sync(a); await sync(b);
    const before = (await a.snapshot()).sketches[0], remote = (await b.snapshot()).sketches[0];
    await b.updateSketch(remote.id, { title: "別端末", strokes: strokes(80) }, remote.localRevision); await sync(b);
    const stale = await a.updateSketch(before.id, { title: "端末A", strokes: strokes(100) }, before.localRevision);
    await a.updateSketch(stale.id, { title: "端末Aの最新", strokes: strokes(120) }, stale.localRevision);
    await sync(a, "conflict");
    const backup = parseSketchBackup(await a.exportSketchBackup());
    assert.equal(backup.sketches.length, 2); assert.ok(backup.sketches.some(sketch => sketch.title === "端末Aの最新" && sketch.strokes[0].points[0].x === 120));
    assert.ok(backup.sketches.every(sketch => sketch.ownerId === null && sketch.serverRevision === null));
    const conflict = (await a.getSyncState()).conflicts[0]; await a.resolveConflict(conflict.id, "keep_both"); await sync(a); await sync(b);
    const titles = (await b.snapshot()).sketches.map(sketch => sketch.title); assert.deepEqual(titles.sort(), ["別端末", "端末Aの最新"].sort());
});

test("Sketchbook SQL: legacy Recall pulls never receive sketch rows, while full stream retains all changes", async t => {
    const owner = await database.addUser(), repo = await device(t, owner);
    await repo.saveSketch({ title: "描画だけ", strokes: strokes(), spaceIds: [] }); await sync(repo);
    const old = await database.pull(owner); assert.ok(old.changes.every(change => ["note", "space"].includes(change.entity))); assert.equal(old.hasMore, false);
    const nextOld = await database.pull(owner, old.cursor); assert.equal(nextOld.changes.length, 0); assert.equal(nextOld.hasMore, false); assert.equal(nextOld.cursor, old.cursor);
    const all = await database.pullSuite(owner); assert.ok(all.changes.some(change => change.entity === "sketch"));
});

test("Sketchbook SQL: owner scoping, invalid strokes and cross-owner source references are enforced server side", async t => {
    const a = await database.addUser(), b = await database.addUser(), repoA = await device(t, a), repoB = await device(t, b);
    const note = await repoA.saveNote({ body: "Aのメモ", spaceIds: [] }); await sync(repoA);
    const drawing = await repoB.saveSketch({ title: "Bの描画", strokes: strokes(), spaceIds: [] }); await sync(repoB);
    const invalid = { id: crypto.randomUUID(), kind: "put_sketch", entityId: crypto.randomUUID(), baseRevision: null, createdAt: new Date().toISOString(), payload: {} as unknown };
    invalid.payload = { ...drawing, id: invalid.entityId, strokes: [{ ...strokes()[0], width: 99 }] };
    await assert.rejects(database.apply(b, invalid), /Invalid stroke/);
    const relationId = crypto.randomUUID();
    await assert.rejects(database.apply(b, { id: crypto.randomUUID(), kind: "put_relation", entityId: relationId, baseRevision: null,
        payload: { id: relationId, kind: "relation", type: "inspired_by", fromItemId: drawing.id, toItemId: note.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null } }), /not found in your account/);
    assert.equal((await database.queryAs(a, "select * from public.sketches")).rows.length, 0);
    await assert.rejects(database.queryAs(a, "select private._sync_sketch($1,$2)", [b, drawing.id]), /permission denied/);
    await assert.rejects(database.queryAs(null, "select public.pull_suite_changes('0',100)"), /permission denied/);
});

test("Sketchbook preview SQL: private object must belong to the current owner and exact live revision", async t => {
    const owner = await database.addUser(), other = await database.addUser(), repo = await device(t, owner);
    const original = await repo.saveSketch({ title: "プレビュー", strokes: strokes(), spaceIds: [] }); await sync(repo);
    const sketch = (await repo.snapshot()).sketches[0], path = `${owner}/${sketch.id}/previews/1-preview.png`;
    await database.queryAs(owner, "insert into storage.objects(bucket_id,name,owner_id) values('personal-tools-private',$1,$2)", [path, owner]);
    await database.queryAs(owner, "select public.register_sketch_preview($1,1,$2,20)", [sketch.id, path]);
    const assets = await database.queryAs(owner, "select * from public.assets where item_id=$1", [original.id]); assert.equal(assets.rows.length, 1); assert.equal(assets.rows[0].source_revision, 1);
    await assert.rejects(database.queryAs(other, "select public.register_sketch_preview($1,1,$2,20)", [sketch.id, path]), /Invalid preview/);
    await repo.updateSketch(sketch.id, { title: "新しい版" }, sketch.localRevision); await sync(repo);
    await assert.rejects(database.queryAs(owner, "select public.register_sketch_preview($1,1,$2,20)", [sketch.id, path]), /revision changed/);
    assert.equal((await database.queryAs(other, "select * from public.assets")).rows.length, 0);
});

test("Sketchbook preview adapter: validates PNG, uploads immutable private path and reclaims stale upload", async t => {
    const repo = await openRecallRepository(name()); t.after(() => repo.close());
    const sketch = await repo.saveSketch({ title: "PNG", strokes: [], spaceIds: [] }), owner = crypto.randomUUID();
    const png = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])], { type: "image/png" });
    const uploaded: string[] = [], removed: string[] = []; let fail = false;
    const client: SketchPreviewClient = { storage: { from(bucket) { assert.equal(bucket, "personal-tools-private"); return {
        async upload(path, body, options) { assert.equal(options.upsert, false); assert.equal(options.cacheControl, "0"); uploaded.push(path); return { data: {}, error: null }; },
        async download() { return { data: png, error: null }; }, async remove(paths) { removed.push(...paths); return { data: {}, error: null }; },
    }; } }, async rpc() { return { data: {}, error: fail ? { message: "Sketch revision changed", code: "22023" } : null }; } };
    const canonical = { ...sketch, ownerId: owner, serverRevision: 2 };
    const path = await uploadSketchPreview(client, owner, canonical, png); assert.ok(path.includes(`/previews/2-`));
    assert.equal(await downloadSketchPreview(client, owner, sketch.id, path), png);
    fail = true; await assert.rejects(uploadSketchPreview(client, owner, canonical, png)); assert.equal(removed[0], uploaded[1]);
    await assert.rejects(uploadSketchPreview(client, owner, canonical, new Blob(["bad"], { type: "image/png" })));
    await assert.rejects(downloadSketchPreview(client, crypto.randomUUID(), sketch.id, path));
});

test("Sketchbook upgrade: v2 notes/outbox/draft survive and full cursor replays sketches hidden behind legacy cursor", async t => {
    const owner = await database.addUser(), source = await device(t, owner);
    const note = await source.saveNote({ body: "旧版のメモ", spaceIds: [] });
    await source.saveSketch({ title: "旧Recallから見えないスケッチ", strokes: strokes(), spaceIds: [] }); await sync(source);
    const canonicalNote = (await source.snapshot()).notes[0];
    await source.saveNote({ ...canonicalNote, body: "あとで更新されたメモ" }, canonicalNote.localRevision); await sync(source);
    const legacy = await database.pull(owner), cached = (await source.snapshot()).notes[0];
    const dbName = name();
    const oldDb = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName, 2);
        req.onupgradeneeded = () => { for (const store of ["notes", "spaces", "outbox", "drafts", "syncOutbox", "conflicts", "meta"]) req.result.createObjectStore(store, { keyPath: "id" }); };
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    const pending = { ...cached, id: crypto.randomUUID(), body: "未送信", serverRevision: null };
    await new Promise<void>((resolve, reject) => {
        const tx = oldDb.transaction(["notes", "drafts", "syncOutbox", "meta"], "readwrite");
        tx.objectStore("notes").put(cached); tx.objectStore("notes").put(pending);
        tx.objectStore("drafts").put({ id: "composer", body: "下書きも残る", spaceIds: [] });
        tx.objectStore("meta").put({ id: "identity", value: owner }); tx.objectStore("meta").put({ id: "seeded", value: true });
        tx.objectStore("meta").put({ id: "cursor", value: legacy.cursor }); tx.objectStore("meta").put({ id: "sequence", value: 1 });
        tx.objectStore("syncOutbox").put({ id: crypto.randomUUID(), kind: "put_note", entityId: pending.id, baseRevision: null, payload: pending, createdAt: new Date().toISOString(), sequence: 1, localRevision: pending.localRevision });
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    }); oldDb.close();
    const upgraded = await openAccountRecallRepository(owner, { name: dbName }); t.after(() => upgraded.close());
    assert.equal((await upgraded.getSyncState()).cursor, "0"); assert.equal((await upgraded.pendingOperations()).length, 1);
    assert.equal((await upgraded.loadDraft()).body, "下書きも残る"); await sync(upgraded);
    const data = await upgraded.snapshot(); assert.equal(data.sketches.length, 1); assert.equal(data.notes.length, 2);
    assert.equal(data.notes.find(item => item.id === note.id)?.body, "あとで更新されたメモ");
});

test("Sketchbook relations: independent devices create the same source edge idempotently", async t => {
    const owner = await database.addUser(), a = await device(t, owner), b = await device(t, owner);
    const note = await a.saveNote({ body: "同じ着想", spaceIds: [] }), sketch = await a.saveSketch({ title: "同じ構図", strokes: [], spaceIds: [] });
    await sync(a); await sync(b);
    const input = { fromItemId: sketch.id, toItemId: note.id, type: "inspired_by" as const };
    const relationA = await a.saveRelation(input), relationB = await b.saveRelation(input); assert.equal(relationA.id, relationB.id);
    await sync(a); await sync(b); await sync(a);
    assert.equal((await a.snapshot()).relations.length, 1); assert.equal((await b.getSyncState()).conflicts.length, 0);
    assert.equal((await database.queryAs(owner, "select * from public.relations")).rows.length, 1);
});

test("Sketchbook previews: reload retries use one immutable path and never remove a preexisting revision", async t => {
    const repo = await openRecallRepository(name()); t.after(() => repo.close());
    const owner = crypto.randomUUID(), sketch = { ...await repo.saveSketch({ title: "再送", strokes: [], spaceIds: [] }), ownerId: owner, serverRevision: 1 };
    const png = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])], { type: "image/png" });
    const paths: string[] = []; let removeCount = 0, stale = false;
    const client: SketchPreviewClient = { storage: { from() { return {
        async upload(path, _body, options) { assert.equal(options.upsert, false); const exists = paths.includes(path); if (!exists) paths.push(path); return { data: {}, error: exists ? { statusCode: "409", code: "KeyAlreadyExists" } : null }; },
        async download() { return { data: png, error: null }; }, async remove() { removeCount++; return { data: {}, error: null }; },
    }; } }, async rpc() { return { data: {}, error: stale ? { code: "22023", message: "Sketch revision changed" } : null }; } };
    assert.equal(await uploadSketchPreview(client, owner, sketch, png), await uploadSketchPreview(client, owner, sketch, png));
    stale = true; await assert.rejects(uploadSketchPreview(client, owner, sketch, png));
    assert.equal(paths.length, 1); assert.equal(removeCount, 0);
});

test("Sketchbook preview: legacy400 Duplicate retries safely while unrelated400 is rejected", async t => {
    const repo = await openRecallRepository(name()); t.after(() => repo.close());
    const owner = crypto.randomUUID(), sketch = { ...await repo.saveSketch({ title: "旧Storage互換", strokes: [], spaceIds: [] }), ownerId: owner, serverRevision: 1 };
    const png = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])], { type: "image/png" });
    let duplicate = true, registrations = 0, removals = 0;
    const client: SketchPreviewClient = { storage: { from() { return {
        async upload() { return { data: null, error: duplicate ? { status: 400, statusCode: "400", error: "Duplicate", message: "The resource already exists" } : { status: 400, code: "InvalidRequest" } }; },
        async download() { return { data: png, error: null }; }, async remove() { removals++; return { data: {}, error: null }; },
    }; } }, async rpc() { registrations++; return { data: {}, error: null }; } };
    assert.ok(await uploadSketchPreview(client, owner, sketch, png)); assert.equal(registrations, 1);
    duplicate = false; await assert.rejects(uploadSketchPreview(client, owner, sketch, png)); assert.equal(registrations, 1); assert.equal(removals, 0);
});

test("shared sync: a newer pulled remote survives cursor commit, reopen, and an older in-flight conflict", async t => {
    const owner = await database.addUser(), dbName = name();
    const a = await openAccountRecallRepository(owner, { name: dbName }); t.after(() => a.close());
    const remoteDevice = await device(t, owner), via = transport(owner);
    await a.saveSketch({ title: "共通の初版", strokes: strokes(), spaceIds: [] }); await sync(a); await sync(remoteDevice);
    const original = (await a.snapshot()).sketches[0];
    let local = await a.updateSketch(original.id, { title: "送信時のローカル", strokes: strokes(200) }, original.localRevision);
    let remote = (await remoteDevice.snapshot()).sketches[0];
    await remoteDevice.updateSketch(remote.id, { title: "リモート2", strokes: strokes(300) }, remote.localRevision); await sync(remoteDevice);
    const operation = (await a.pendingOperations())[0], delayedConflict = await via.push(operation);
    assert.equal(delayedConflict.status, "conflict"); assert.equal(delayedConflict.record.serverRevision, 2);
    local = await a.updateSketch(local.id, { title: "さらに新しいローカル", strokes: strokes(220) }, local.localRevision);
    remote = (await remoteDevice.snapshot()).sketches[0];
    await remoteDevice.updateSketch(remote.id, { title: "リモート3", strokes: strokes(320) }, remote.localRevision); await sync(remoteDevice);
    const page = await via.pull((await a.getSyncState()).cursor, 100); await a.acceptPull(page);
    assert.equal((await a.snapshot()).sketches[0].title, "さらに新しいローカル");
    assert.equal((await a.getSyncState()).cursor, page.cursor); a.close();
    const reopened = await openAccountRecallRepository(owner, { name: dbName }); t.after(() => reopened.close());
    await reopened.acceptPush(operation, delayedConflict);
    const canonical = (await reopened.snapshot()).sketches[0], state = await reopened.getSyncState();
    assert.equal(canonical.title, "リモート3"); assert.equal(canonical.serverRevision, 3); assert.equal(state.cursor, page.cursor);
    assert.equal(state.pending, 0); assert.equal(state.conflicts.length, 1);
    assert.equal((state.conflicts[0].local as { title: string }).title, "さらに新しいローカル");
    assert.equal((state.conflicts[0].remote as { title: string }).title, "リモート3");
    remote = (await remoteDevice.snapshot()).sketches[0];
    await remoteDevice.updateSketch(remote.id, { title: "リモート4" }, remote.localRevision); await sync(remoteDevice);
    await reopened.acceptPull(await via.pull(state.cursor, 100));
    const refreshed = (await reopened.getSyncState()).conflicts[0];
    assert.equal((refreshed.local as { title: string }).title, "さらに新しいローカル");
    assert.equal((refreshed.remote as { title: string }).title, "リモート4");
    assert.equal((await reopened.snapshot()).sketches[0].title, "リモート4");
});

test("shared sync: deferred remote outranks an older successful ack without dropping a later local edit", async t => {
    const owner = await database.addUser(), a = await device(t, owner), b = await device(t, owner), via = transport(owner);
    await a.saveSketch({ title: "初版", strokes: strokes(), spaceIds: [] }); await sync(a); await sync(b);
    let local = (await a.snapshot()).sketches[0];
    local = await a.updateSketch(local.id, { title: "適用される2版" }, local.localRevision);
    const first = (await a.pendingOperations())[0], delayedSuccess = await via.push(first); assert.equal(delayedSuccess.status, "applied");
    await sync(b); const remote = (await b.snapshot()).sketches[0];
    await b.updateSketch(remote.id, { title: "さらに新しいリモート3" }, remote.localRevision); await sync(b);
    await a.acceptPull(await via.pull((await a.getSyncState()).cursor, 100));
    await a.acceptPush(first, delayedSuccess);
    assert.equal((await a.snapshot()).sketches[0].title, "さらに新しいリモート3");
    assert.equal((await a.snapshot()).sketches[0].serverRevision, 3); assert.equal((await a.pendingOperations()).length, 0);
    assert.ok((await a.snapshot()).sketches[0].localRevision > local.localRevision, "Adopting a newer canonical original must invalidate an already open editor");
    await assert.rejects(a.updateSketch(local.id, { title: "古い編集画面からの上書き" }, local.localRevision), /別の画面/);

    // The same timing with another local operation retains it until the server can
    // compare its immutable predecessor revision and return a real conflict.
    local = (await a.snapshot()).sketches[0]; local = await a.updateSketch(local.id, { title: "先行ローカル4" }, local.localRevision);
    const next = (await a.pendingOperations())[0], ack4 = await via.push(next); await sync(b);
    const b4 = (await b.snapshot()).sketches[0]; await b.updateSketch(b4.id, { title: "リモート5" }, b4.localRevision); await sync(b);
    local = await a.updateSketch(local.id, { title: "未送信の最新ローカル" }, local.localRevision);
    await a.acceptPull(await via.pull((await a.getSyncState()).cursor, 100)); await a.acceptPush(next, ack4);
    assert.equal((await a.snapshot()).sketches[0].title, "未送信の最新ローカル"); assert.equal((await a.pendingOperations()).length, 1);
    await sync(a, "conflict");
    const state = await a.getSyncState(); assert.equal((await a.snapshot()).sketches[0].title, "リモート5");
    assert.equal((state.conflicts[0].local as { title: string }).title, "未送信の最新ローカル"); assert.equal(state.conflicts[0].remote.serverRevision, 5);
});

test("Sketchbook JSONB budget matches actual PostgreSQL UTF-8, separators and exponent expansion without rounding", async () => {
    const values = [null, true, false, [], {}, ["日常🌿", "\b\t\n\f\r\u0001", '"\\/'],
        [0, -0, 1200, 0.000001, 1e-7, 1.234567890123456e-8, 1e-300, Number.MIN_VALUE, -5e-324, 1e21, 1.23e25],
        { text: "原本\u2028\u2029", nested: [{ x: 1e-300, y: 0.1, pressure: 0.3333333333333333 }] }];
    for (const value of values) {
        const result = await database.db.query("select octet_length($1::jsonb::text) as bytes", [JSON.stringify(value)]);
        assert.equal(jsonbByteLength(value), result.rows[0].bytes, JSON.stringify(value));
    }
    assert.throws(() => jsonbByteLength("\u0000"), /文字/);
    assert.throws(() => jsonbByteLength("\ud800"), /文字/);
    assert.throws(() => jsonbByteLength("\udc00"), /文字/);
});

test("Sketchbook size boundaries: locally accepted regular and scientific originals reach actual SQL; oversized originals never enter outbox", { timeout: 20000 }, async t => {
    const owner = await database.addUser(), repo = await device(t, owner);
    await sync(repo);
    const regular = Array.from({ length: 2000 }, (_, index): SketchStroke => ({ id: index.toString(36), tool: "pen", color: "#000000", width: 1,
        points: Array.from({ length: 10 }, () => ({ x: 100, y: 10, pressure: 0 })) }));
    assert.ok(new TextEncoder().encode(JSON.stringify(regular)).length < 750000);
    const actual = await database.db.query("select octet_length($1::jsonb::text) as bytes", [JSON.stringify(regular)]);
    assert.ok(Number(actual.rows[0].bytes) > 850000); assert.equal(jsonbByteLength(regular), actual.rows[0].bytes);
    assert.throws(() => parseSketchStrokes(regular), /大きすぎ/);
    const beforePending = (await repo.pendingOperations()).length;
    await assert.rejects(repo.saveSketch({ title: "原本を丸めず拒否", strokes: regular, spaceIds: [] }), /大きすぎ/);
    assert.equal((await repo.pendingOperations()).length, beforePending); assert.equal((await repo.snapshot()).sketches.length, 0);

    const cases = [
        (count: number) => regular.slice(0, count),
        (count: number): SketchStroke[] => [{ id: "tiny", tool: "pen", color: "#000000", width: 1,
            points: Array.from({ length: count }, () => ({ x: 1e-300, y: Number.MIN_VALUE, pressure: 1.234567890123456e-300 })) }],
    ];
    for (const [index, candidate] of cases.entries()) {
        let low = 1, high = 2000;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            try { parseSketchStrokes(candidate(middle)); low = middle; } catch { high = middle - 1; }
        }
        const accepted = parseSketchStrokes(candidate(low));
        assert.throws(() => parseSketchStrokes(candidate(low + 1)), /大きすぎ/);
        const saved = await repo.saveSketch({ title: `境界${index}`, strokes: accepted, spaceIds: [] });
        const operation = (await repo.pendingOperations()).find(op => op.entityId === saved.id)!;
        const { sequence: _s, localRevision: _l, ...wire } = operation;
        const sizes = await database.db.query("select octet_length($1::jsonb::text) as original_bytes,octet_length($2::jsonb::text) as operation_bytes", [JSON.stringify(accepted), JSON.stringify(wire)]);
        assert.equal(jsonbByteLength(accepted), sizes.rows[0].original_bytes); assert.equal(jsonbByteLength(wire), sizes.rows[0].operation_bytes);
        assert.ok(Number(sizes.rows[0].original_bytes) <= 850000); assert.ok(Number(sizes.rows[0].operation_bytes) <= 1048576);
        await sync(repo);
        const canonical = (await repo.snapshot()).sketches.find(sketch => sketch.id === saved.id)!;
        assert.equal(canonical.serverRevision, 1); assert.deepEqual(canonical.strokes, accepted, "Small coordinates retain their exact original JS values");
    }
    assert.equal((await repo.pendingOperations()).length, 0);
});

test("Sketchbook operation and space limits reject unsendable imports atomically and retain the prior draft", async t => {
    const repo = await openRecallRepository(name()); t.after(() => repo.close());
    await repo.saveSketchDraft({ title: "保存済みの下書き", strokes: strokes(), spaceIds: [] });
    const sketch = await repo.saveSketch({ title: "既存原本", strokes: strokes(), spaceIds: [] });
    await repo.saveSketchDraft({ title: "次の下書き", strokes: strokes(), spaceIds: [] });
    const thousand = Array.from({ length: 1000 }, (_, index) => `space-${index}`);
    assert.equal(parseSketchSpaceIds([...thousand, thousand[0]]).length, 1000);
    assert.throws(() => parseSketchSpaceIds([...thousand, "space-1000"]), /1,000/);
    await assert.rejects(repo.saveSketch({ title: "多すぎるスペース", strokes: [], spaceIds: [...thousand, "space-1000"] }), /1,000/);
    const backup = await repo.exportSketchBackup(), largeDate = " ".repeat(1100000) + "Oct 30 2026";
    assert.ok(Number.isFinite(Date.parse(largeDate)));
    assert.throws(() => assertSketchSyncBudget({ ...sketch, createdAt: largeDate }), /大きすぎ/);
    await assert.rejects(repo.importSketchBackup({ ...backup, sketches: [{ ...backup.sketches[0], createdAt: largeDate }] }), /大きすぎ/);
    const manySpaces = Array.from({ length: 1001 }, (_, index) => ({ id: `space-${index}`, name: `Space ${index}`, color: "#000000", createdAt: sketch.createdAt }));
    await assert.rejects(repo.importSketchBackup({ ...backup, spaces: manySpaces, sketches: [{ ...backup.sketches[0], spaceIds: manySpaces.map(space => space.id) }] }), /1,000/);
    assert.equal((await repo.snapshot()).sketches.length, 1); assert.equal((await repo.loadSketchDraft()).title, "次の下書き");
});

test("shared sync: an unchanged successful acknowledgement retains the editor revision", async t => {
    const owner = await database.addUser(), repo = await device(t, owner); await sync(repo);
    const sketch = await repo.saveSketch({ title: "そのまま同期", strokes: strokes(), spaceIds: [] });
    const operation = (await repo.pendingOperations())[0], result = await transport(owner).push(operation);
    await repo.acceptPush(operation, result);
    const acknowledged = (await repo.snapshot()).sketches[0]; assert.equal(acknowledged.localRevision, sketch.localRevision);
    await repo.updateSketch(sketch.id, { title: "引き続き編集" }, sketch.localRevision);
});
