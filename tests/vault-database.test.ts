import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {createTestDatabase,USER_A,USER_B} from "./helpers/database.ts";
import {requireVault} from "../packages/api-client/src/vault.ts";
import {openAccountRecallRepository} from "../packages/api-client/src/repository.ts";
import {createEncryptedSyncTransport,createSyncEngine} from "../packages/api-client/src/sync.ts";
import {prepareCloudVault} from "../packages/api-client/src/vault-cloud.ts";
import {clientFor} from "./helpers/vault-cloud-client.ts";

test("vault SQL: ciphertext sync is isolated, idempotent across fresh encryption nonces, and preserves conflicts",async()=>{
 const db=await createTestDatabase();try{
  await db.addUser(USER_A);await db.addUser(USER_B);const a=clientFor(db,USER_A),b=clientFor(db,USER_B);assert.equal((await a.rpc("register_vault",{p_descriptor:requireVault().descriptor})).error,null);assert.equal((await b.rpc("register_vault",{p_descriptor:requireVault().descriptor})).error,null);
  const left=await openAccountRecallRepository(USER_A,{name:`test-vault-left-${crypto.randomUUID()}`}),right=await openAccountRecallRepository(USER_A,{name:`test-vault-right-${crypto.randomUUID()}`});
  const transport=createEncryptedSyncTransport(a,USER_A),first=await left.saveNote({body:"クラウドに平文を置かない",spaceIds:[]});const engine=createSyncEngine(left,transport);assert.equal((await engine.run()).phase,"idle");
  assert.ok(!JSON.stringify((await db.db.query("select * from public.vault_records")).rows).includes(first.body));assert.equal((await db.queryAs(USER_B,"select * from public.vault_records")).rows.length,0);await assert.rejects(db.queryAs(null,"select * from public.vault_records"));
  const initial=await transport.pull("0",100);await right.prepareEncryptedSync(initial.changes.map(c=>c.record),"existing");await right.acceptPull(initial);const old=(await right.snapshot()).notes[0];const latest=(await left.snapshot()).notes[0];await left.saveNote({...latest,body:"左の版"},latest.localRevision);const op=(await left.pendingOperations())[0];const result=await transport.push(op);await left.acceptPush(op,result);assert.deepEqual(await createEncryptedSyncTransport(a,USER_A).push(op),result);await assert.rejects(transport.push({...op,payload:{...op.payload,body:"操作IDを再利用した別本文"} as any}));
  await right.saveNote({...old,body:"右の版"},old.localRevision);const other=createSyncEngine(right,createEncryptedSyncTransport(a,USER_A));assert.equal((await other.run()).phase,"conflict");assert.equal((await right.getSyncState()).conflicts[0].local.kind,"note");engine.stop();other.stop();left.close();right.close();
  const funcs=await db.db.query("select n.nspname,p.proname,p.prosecdef,has_function_privilege('anon',p.oid,'execute') as anon from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.proname in ('register_vault','push_vault_record','pull_vault_changes','finish_vault_migration')");for(const f of funcs.rows as any[]){assert.equal(f.anon,false);assert.equal(f.prosecdef,f.nspname==="private");}
 }finally{await db.close();}
});
test("vault migration: archive and verified encrypted sync precede atomic removal of legacy originals and history",async()=>{
 const db=await createTestDatabase();try{
  await db.addUser(USER_A);const repo=await openAccountRecallRepository(USER_A,{name:`test-vault-migrate-${crypto.randomUUID()}`}),note=await repo.saveNote({body:"既存の原本と履歴を移す",spaceIds:[]}),op=(await repo.pendingOperations()).find(o=>o.entityId===note.id)!;
  await db.apply(USER_A,op);await prepareCloudVault(clientFor(db,USER_A),repo,()=>true);
  for(const table of ["items","notes","spaces","sync_operations","sync_changes"]){assert.equal((await db.db.query(`select count(*)::int as n from public.${table} where owner_id=$1`,[USER_A])).rows[0].n,0);}
  const encrypted=await db.db.query("select * from public.vault_records where owner_id=$1",[USER_A]);assert.ok(encrypted.rows.length>0);assert.ok(!JSON.stringify(encrypted.rows).includes(note.body));assert.ok((await db.db.query("select * from public.vault_archives where owner_id=$1",[USER_A])).rows.length>0);assert.equal((await db.db.query("select legacy_migrated from public.vault_keys where owner_id=$1",[USER_A])).rows[0].legacy_migrated,true);
  await assert.rejects(db.apply(USER_A,{...op,id:crypto.randomUUID()}));assert.equal((await repo.snapshot()).notes[0].body,note.body);repo.close();
 }finally{await db.close();}
});
test("vault migration: an archive failure retains all legacy data and a retry completes without losing offline edits",async()=>{
 const db=await createTestDatabase();try{
  await db.addUser(USER_A);const repo=await openAccountRecallRepository(USER_A,{name:`test-vault-retry-${crypto.randomUUID()}`}),note=await repo.saveNote({body:"削除前の移行検証",spaceIds:[]}),op=(await repo.pendingOperations()).find(o=>o.entityId===note.id)!;await db.apply(USER_A,op);
  await repo.saveNote({...note,body:"まだ送っていない最新の版"},note.localRevision);const good=clientFor(db,USER_A),failing={...good,rpc:async(name:string,args:Record<string,unknown>={})=>name==="store_vault_archive"?{data:null,error:new Error("offline")}:good.rpc(name,args)};
  await assert.rejects(prepareCloudVault(failing,repo,()=>true));assert.equal((await db.db.query("select count(*)::int as n from public.notes where owner_id=$1",[USER_A])).rows[0].n,1);assert.equal((await repo.snapshot()).notes[0].body,"まだ送っていない最新の版");
  await prepareCloudVault(good,repo,()=>true);assert.equal((await repo.snapshot()).notes[0].body,"まだ送っていない最新の版");assert.equal((await db.db.query("select count(*)::int as n from public.notes where owner_id=$1",[USER_A])).rows[0].n,0);repo.close();
 }finally{await db.close();}
});
