import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {createTestDatabase,USER_A,USER_B} from "./helpers/database.ts";
import {clientFor} from "./helpers/vault-cloud-client.ts";
import {requireVault,encryptVault,vaultBlobPath} from "../packages/api-client/src/vault.ts";
import {prepareVaultRetention} from "../packages/api-client/src/vault-retention.ts";
import {createEncryptedSyncTransport,createSyncEngine} from "../packages/api-client/src/sync.ts";
import {openAccountRecallRepository} from "../packages/api-client/src/repository.ts";
import {handleRetention} from "../supabase/functions/vault-retention/handler.ts";
const past=new Date(Date.now()-100*86400000).toISOString();
async function setup(){const db=await createTestDatabase(),client=clientFor(db,USER_A);assert.equal((await client.rpc("register_vault",{p_descriptor:requireVault().descriptor})).error,null);await db.db.query("update public.vault_keys set legacy_migrated=true where owner_id=$1",[USER_A]);const repo=await openAccountRecallRepository(USER_A,{name:`test-retention-${crypto.randomUUID()}`});return {db,client,repo,transport:createEncryptedSyncTransport(client,USER_A)};}
test("retention SQL: legacy history and archives are indexed before expiry, then ciphertext and stale restores are removed",async()=>{
 const {db,client,repo}=await setup();try{
  const note=await repo.saveNote({body:"秘密の過去のメモ",spaceIds:[]}),op=(await repo.pendingOperations()).find(op=>op.entityId===note.id)!,legacy=createEncryptedSyncTransport(client,USER_A,{legacy:true});
  await legacy.push(op);
  const deleted={...op,id:crypto.randomUUID(),baseRevision:1,previousOperationId:null,payload:{...note,deletedAt:past}};await legacy.push(deleted);
  const archive=await encryptVault([{id:note.id,owner_id:USER_A,body:note.body}],`archive:${USER_A}:items:0`);assert.equal((await client.rpc("store_vault_archive",{p_source:"items",p_page:0,p_count:1,p_box:archive})).error,null);
  await client.rpc("begin_vault_retention");assert.ok((await client.rpc("finish_vault_retention")).error);await assert.rejects(legacy.push({...op,id:crypto.randomUUID()}));
  await prepareVaultRetention(client,USER_A,()=>true);
  for(const table of ["vault_records","vault_operations","vault_archives"])assert.equal((await db.db.query(`select count(*)::int n from public.${table} where owner_id=$1`,[USER_A])).rows[0].n,0);
  const changes=(await db.db.query("select box,purge from public.vault_changes")).rows;assert.ok(changes.every((r:any)=>r.box===null&&r.purge));
  const transport=createEncryptedSyncTransport(client,USER_A),result=await transport.push({...deleted,id:crypto.randomUUID(),baseRevision:999,payload:{...deleted.payload,deletedAt:null}});assert.equal(result.status,"purged");
  assert.ok((await transport.pull("0",100)).purges?.some(p=>p.id===note.id));
  // Receipts preserve operation immutability without retaining any encrypted content.
  assert.equal((await transport.push(deleted)).status,"purged");await assert.rejects(transport.push({...deleted,payload:{...deleted.payload,body:"改変"}}));
  assert.equal((await db.queryAs(USER_B,"select * from public.vault_tombstones")).rows.length,0);
 }finally{repo.close();await db.close();}
});
test("retention SQL: a restore cancels the deadline; retrash uses its own deadline and background expiry blocks an offline resurrection",async()=>{
 const {db,client,repo,transport}=await setup();try{
  const note=await repo.saveNote({body:"復元して残す",spaceIds:[]});const engine=createSyncEngine(repo,transport);assert.equal((await engine.run()).phase,"idle");
  await prepareVaultRetention(client,USER_A,()=>true);
  let current=(await repo.snapshot()).notes[0];current=await repo.saveNote({...current,deletedAt:new Date().toISOString()},current.localRevision);assert.equal((await engine.run()).phase,"idle");
  current=(await repo.snapshot()).notes[0];await repo.saveNote({...current,deletedAt:null},current.localRevision);assert.equal((await engine.run()).phase,"idle");
  assert.equal((await db.db.query("select private.expire_vault_records($1,$2::timestamptz) n",[USER_A,new Date(Date.now()+200*86400000).toISOString()])).rows[0].n,0);
  current=(await repo.snapshot()).notes[0];await repo.saveNote({...current,deletedAt:new Date().toISOString()},current.localRevision);await engine.run();
  assert.equal((await db.db.query("select private.expire_vault_records($1,$2::timestamptz) n",[USER_A,new Date(Date.now()+200*86400000).toISOString()])).rows[0].n,1);
  await engine.run();assert.equal((await repo.snapshot()).notes.length,0);assert.equal((await repo.getSyncState()).pending,0);
  engine.stop();
 }finally{repo.close();await db.close();}
});
test("retention SQL: space deletion bypasses stale revisions and is terminal while originals, other spaces, projects and tags survive",async()=>{
 const {db,client,repo,transport}=await setup();try{
  const space=await repo.createSpace("外す場所","#3b82f6"),other=await repo.createSpace("残す場所","#3b82f6");await repo.saveNote({body:"原本を守る",spaceIds:[space.id,other.id]});const engine=createSyncEngine(repo,transport);assert.equal((await engine.run()).phase,"idle");await prepareVaultRetention(client,USER_A,()=>true);
  await repo.deleteSpace(space.id);assert.equal((await engine.run()).phase,"idle");const snap=await repo.snapshot();assert.equal(snap.notes.length,1);assert.deepEqual(snap.notes[0].spaceIds,[other.id]);
  const pending={id:crypto.randomUUID(),kind:"put_space" as const,entityId:space.id,baseRevision:999,payload:{...space,name:"古い端末から復活"}};assert.equal((await transport.push(pending)).status,"purged");
  assert.equal((await db.db.query("select count(*)::int n from public.vault_records where entity='note'")).rows[0].n,1);engine.stop();
 }finally{repo.close();await db.close();}
});
test("retention SQL: GC retains shared paths, claims only orphans, rejects late uploads, and owner/worker privileges are isolated",async()=>{
 const {db,client,repo}=await setup();try{
  await prepareVaultRetention(client,USER_A,()=>true);const id=crypto.randomUUID(),other=crypto.randomUUID(),path=await vaultBlobPath(USER_A,id,"shared-fixture");
  for(const recordId of [id,other])assert.equal((await client.rpc("register_vault_file",{p_entity:"resource",p_id:recordId,p_path:path})).error,null);
  await db.db.query("select private.purge_vault_entity($1,'resource',$2,clock_timestamp()-interval '1 hour')",[USER_A,id]);assert.equal((await db.db.query("select public.claim_vault_file_gc(20) x")).rows[0].x.length,0);
  await db.db.query("select private.purge_vault_entity($1,'resource',$2,clock_timestamp()-interval '1 hour')",[USER_A,other]);const claims=(await db.db.query("select public.claim_vault_file_gc(20) x")).rows[0].x as any[];assert.equal(claims.length,1);
  assert.ok((await client.rpc("register_vault_file",{p_entity:"resource",p_id:crypto.randomUUID(),p_path:path})).error);
  const claim=claims[0];await db.db.query("select public.complete_vault_file_gc($1,$2,$3,true)",[USER_A,path,claim.token]);assert.equal((await db.db.query("select public.claim_vault_file_gc(20) x")).rows[0].x.length,0);
  for(const role of ["anon","authenticated"])for(const fn of ["public.claim_vault_file_gc(integer)","public.complete_vault_file_gc(uuid,text,uuid,boolean)","private.expire_vault_records(uuid,timestamptz)","private.push_vault_record_v1(jsonb)","private.run_vault_retention()"]){assert.equal((await db.db.query("select has_function_privilege($1,$2,'execute') allowed",[role,fn])).rows[0].allowed,false);}
  await assert.rejects(db.queryAs(USER_B,"insert into storage.objects(bucket_id,name) values('personal-tools-vault',$1)",[path]));
 }finally{repo.close();await db.close();}
});
test("retention worker: authenticates before claiming, removes Storage bytes, and retains failed deletions for retry",async()=>{
 let calls:string[]=[],paths:string[]=[];const client={async rpc(name:string,args:any){calls.push(name);if(name==="verify_retention_worker")return {data:args.p_token==="a".repeat(64),error:null};if(name==="claim_vault_file_gc")return {data:[{ownerId:USER_A,path:"first",token:"one"},{ownerId:USER_A,path:"retry",token:"two"}],error:null};assert.equal(args.p_success,args.p_path==="first");return {data:null,error:null};},storage:{from(bucket:string){assert.equal(bucket,"personal-tools-vault");return {async remove(p:string[]){paths.push(...p);return {error:p[0]==="retry"?new Error("transient"):null};}};}}};
 assert.equal((await handleRetention(new Request("https://local",{method:"POST"}),client)).status,401);assert.equal(calls.length,0);
 const response=await handleRetention(new Request("https://local",{method:"POST",headers:{"X-Retention-Token":"a".repeat(64)}}),client);assert.equal(response.status,503);assert.deepEqual(await response.json(),{removed:1,failed:1});assert.deepEqual(paths,["first","retry"]);assert.equal(calls.filter(x=>x==="complete_vault_file_gc").length,2);
});
