import "fake-indexeddb/auto";
import test, {before, after, type TestContext} from "node:test";
import assert from "node:assert/strict";
import {
  openAccountRecallRepository,
  createSyncEngine,
  createSupabaseSyncTransport,
  type AccountRecallRepository,
  type SyncTransport,
} from "../packages/api-client/src/index.ts";
import {parseBackup, type Note} from "../packages/core/src/index.ts";
import {createTestDatabase} from "./helpers/database.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
before(async () => { database = await createTestDatabase(); });
after(async () => { await database.close(); });

const uniqueDatabase = () => `independent-sync-${crypto.randomUUID()}`;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}
async function device(t: TestContext, userId: string, name = uniqueDatabase()) {
  const repo = await openAccountRecallRepository(userId, {name});
  t.after(() => repo.close());
  return repo;
}
function sqlTransport(userId: string): SyncTransport {
  // The production adapter validates the actual JSON emitted by the unchanged migration.
  // Supabase's documented invocation shape: https://supabase.com/docs/reference/javascript/rpc
  return createSupabaseSyncTransport({
    async rpc(name, args) {
      try {
        if (name === "apply_sync_operation") {
          return {data: await database.apply(userId, args.p_operation), error: null};
        }
        if (name === "pull_suite_changes") {
          return {data: await database.pullSuite(userId, String(args.p_cursor), Number(args.p_limit)), error: null};
        }
        throw new Error(`Unexpected RPC: ${name}`);
      } catch (error) {
        return {data: null, error: {
          message: error instanceof Error ? error.message : String(error),
          code: typeof error === "object" && error && "code" in error ? String(error.code) : undefined,
        }};
      }
    },
  }, userId);
}
async function run(repo: AccountRecallRepository, via = sqlTransport(repo.ownerId)) {
  const engine = createSyncEngine(repo, via);
  try {
    const state = await engine.run();
    assert.equal(state.phase, "idle", state.error);
    assert.equal(state.pending, 0);
    return state;
  } finally { engine.stop(); }
}

test("independent: two tabs sending the same durable operation cause one server mutation", {timeout: 15000}, async t => {
  const user = await database.addUser(), name = uniqueDatabase();
  const a = await device(t, user, name), b = await device(t, user, name);
  await run(a);
  const note = await a.saveNote({body: "same operation from two tabs", spaceIds: ["daily"]});
  const queued = (await a.pendingOperations())[0];
  const bothSending = deferred();
  let pushes = 0;
  const base = sqlTransport(user);
  const gate: SyncTransport = {
    userId: user,
    pull: base.pull,
    async push(operation) {
      pushes++;
      if (pushes === 2) bothSending.resolve();
      await bothSending.promise;
      return base.push(operation);
    },
  };
  const first = createSyncEngine(a, gate), second = createSyncEngine(b, gate);
  t.after(() => { bothSending.resolve(); first.stop(); second.stop(); });
  const states = await Promise.all([first.run(), second.run()]);
  assert.ok(states.every(state => state.phase === "idle"));
  assert.equal(pushes, 2);
  const operations = await database.queryAs(user,
    "select id from public.sync_operations where id=$1", [queued.id]);
  const canonical = await database.queryAs(user,
    "select revision from public.items where id=$1", [note.id]);
  assert.equal(operations.rows.length, 1);
  assert.equal(Number(canonical.rows[0].revision), 1);
  assert.equal((await a.getSyncState()).pending, 0);
  assert.equal((await b.snapshot()).notes[0].body, note.body);
});

test("independent: a late pull after sign-out does not advance the closed account cursor", {timeout: 15000}, async t => {
  const user = await database.addUser(), other = await database.addUser();
  const name = uniqueDatabase(), reader = await device(t, user, name), writer = await device(t, user);
  await run(reader);
  await run(writer);
  const cursorBefore = (await reader.getSyncState()).cursor;
  const remote = await writer.saveNote({body: "only the signed-out account may receive this", spaceIds: []});
  await run(writer);
  const started = deferred(), release = deferred(), base = sqlTransport(user);
  const delayed: SyncTransport = {
    userId: user, push: base.push,
    async pull(cursor, limit) {
      const response = await base.pull(cursor, limit);
      started.resolve();
      await release.promise;
      return response;
    },
  };
  const engine = createSyncEngine(reader, delayed);
  const flight = engine.run();
  await started.promise;
  engine.stop();
  reader.close();
  const otherAccount = await device(t, other);
  release.resolve();
  assert.equal((await flight).phase, "stopped");
  assert.equal((await otherAccount.snapshot()).notes.length, 0);
  const reopened = await device(t, user, name);
  assert.equal((await reopened.getSyncState()).cursor, cursorBefore);
  assert.equal((await reopened.snapshot()).notes.length, 0);
  await run(reopened);
  assert.equal((await reopened.snapshot()).notes[0].id, remote.id);
});

test("independent: failed pull persistence rolls back records and cursor together", {timeout: 15000}, async t => {
  const user = await database.addUser(), reader = await device(t, user), writer = await device(t, user);
  await run(reader);
  await run(writer);
  const initialCursor = (await reader.getSyncState()).cursor;
  await writer.saveNote({body: "first item in the pull page", spaceIds: []});
  await writer.saveNote({body: "second item in the pull page", spaceIds: []});
  await run(writer);
  const page = await sqlTransport(user).pull(initialCursor, 100);
  assert.equal(page.changes.length, 2);
  const originalPut = IDBObjectStore.prototype.put;
  let writes = 0;
  IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
    if (this.name === "notes" && ++writes === 2) throw new DOMException("simulated full disk", "QuotaExceededError");
    return originalPut.apply(this, args);
  };
  try { await assert.rejects(reader.acceptPull(page)); }
  finally { IDBObjectStore.prototype.put = originalPut; }
  assert.equal((await reader.snapshot()).notes.length, 0);
  assert.equal((await reader.getSyncState()).cursor, initialCursor);
  await run(reader);
  assert.equal((await reader.snapshot()).notes.length, 2);
});

test("independent: the real 100-row RPC page boundary preserves all 205 notes", {timeout: 30000}, async t => {
  const user = await database.addUser(), writer = await device(t, user), reader = await device(t, user);
  await run(writer);
  for (let index = 0; index < 205; index++) {
    await writer.saveNote({body: `page boundary note ${index}`, spaceIds: ["research"]});
  }
  await run(writer);
  const base = sqlTransport(user), calls: {cursor: string; size: number}[] = [];
  await run(reader, {
    userId: user, push: base.push,
    async pull(cursor, limit) {
      const page = await base.pull(cursor, limit);
      calls.push({cursor, size: page.changes.length});
      return page;
    },
  });
  assert.deepEqual(calls.map(call => call.size), [100, 100, 8]);
  const snapshot = await reader.snapshot();
  assert.equal(snapshot.notes.length, 205);
  assert.equal(new Set(snapshot.notes.map(note => note.id)).size, 205);
  assert.equal((await reader.getSyncState()).cursor, "208");
});

test("independent: same item UUID in two owner namespaces cannot mix account contents", {timeout: 15000}, async t => {
  const userA = await database.addUser(), userB = await database.addUser();
  const a = await device(t, userA), b = await device(t, userB);
  await run(a);
  await run(b);
  const noteA = await a.saveNote({body: "private A text", spaceIds: []});
  await run(a);
  await database.apply(userB, {
    id: crypto.randomUUID(), kind: "put_note", entityId: noteA.id, baseRevision: null,
    payload: {...noteA, ownerId: userA, body: "private B text with forged A owner"},
  });
  await run(b);
  await run(a);
  assert.equal((await a.snapshot()).notes[0].body, "private A text");
  const bCopy = (await b.snapshot()).notes[0];
  assert.equal(bCopy.id, noteA.id);
  assert.equal(bCopy.ownerId, userB);
  assert.equal(bCopy.body, "private B text with forged A owner");
});

test("independent: unresolved latest conflict copy is included in portable backup", {timeout: 15000}, async t => {
  const user = await database.addUser(), a = await device(t, user), b = await device(t, user);
  await run(a);
  await a.saveNote({body: "shared starting text", spaceIds: ["daily"]});
  await run(a);
  await run(b);
  const aNote = (await a.snapshot()).notes[0];
  await a.saveNote({...aNote, body: "remote accepted text"}, aNote.localRevision);
  await run(a);
  let bNote = (await b.snapshot()).notes[0];
  bNote = await b.saveNote({...bNote, body: "older rejected local text"}, bNote.localRevision);
  await b.saveNote({...bNote, body: "latest local text needing backup"}, bNote.localRevision);
  const engine = createSyncEngine(b, sqlTransport(user));
  t.after(() => engine.stop());
  assert.equal((await engine.run()).phase, "conflict");
  const state = await b.getSyncState();
  assert.equal((state.conflicts[0].local as Note).body, "latest local text needing backup");
  const backup = parseBackup(await b.exportBackup());
  assert.ok(backup.notes.some(note => note.body === "remote accepted text"));
  assert.ok(backup.notes.some(note => note.body === "latest local text needing backup"),
    "A complete backup must retain the only stored copy of the unresolved latest local text");
  assert.equal(new Set(backup.notes.map(note => note.id)).size, backup.notes.length);
});

test("independent: keep-remote resolves against the current canonical version without duplicate notes", {timeout: 15000}, async t => {
  const user = await database.addUser(), a = await device(t, user), b = await device(t, user);
  await run(a);
  await a.saveNote({body: "start", spaceIds: []});
  await run(a);
  await run(b);
  let aNote = (await a.snapshot()).notes[0];
  await a.saveNote({...aNote, body: "remote revision 2"}, aNote.localRevision);
  await run(a);
  const stale = (await b.snapshot()).notes[0];
  await b.saveNote({...stale, body: "local conflicting text"}, stale.localRevision);
  const engine = createSyncEngine(b, sqlTransport(user));
  t.after(() => engine.stop());
  assert.equal((await engine.run()).phase, "conflict");
  aNote = (await a.snapshot()).notes[0];
  await a.saveNote({...aNote, body: "remote revision 3"}, aNote.localRevision);
  await run(a);
  assert.equal((await engine.run()).phase, "conflict");
  const conflict = (await b.getSyncState()).conflicts[0];
  await b.resolveConflict(conflict.id, "keep_remote");
  await run(b);
  const final = await b.snapshot();
  assert.equal(final.notes.length, 1);
  assert.equal(final.notes[0].body, "remote revision 3");
  assert.equal((await b.getSyncState()).conflicts.length, 0);
});
