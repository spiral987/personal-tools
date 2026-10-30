import test,{before,after} from "node:test";
import assert from "node:assert/strict";
import {createTestDatabase} from "./helpers/database.ts";

let database:Awaited<ReturnType<typeof createTestDatabase>>;
before(async()=>{database=await createTestDatabase();});
after(async()=>{await database?.close();});
const noteOperation=(id=crypto.randomUUID(),body="散歩の思考",baseRevision:number|null=null,spaceIds:string[]=[])=>({
  id:crypto.randomUUID(),kind:"put_note",entityId:id,baseRevision,createdAt:new Date().toISOString(),
  payload:{id,kind:"note",originApp:"recall",ownerId:null as string|null,body,spaceIds,pinned:false,
    createdAt:"2026-10-28T01:00:00.000Z",updatedAt:"2026-10-28T01:00:00.000Z",deletedAt:null as string|null,localRevision:1,serverRevision:baseRevision},
});
const spaceOperation=(id="daily",name="日常")=>({id:crypto.randomUUID(),kind:"put_space",entityId:id,baseRevision:null,
  payload:{id,name,color:"#729379",createdAt:"2026-10-28T01:00:00.000Z"},createdAt:new Date().toISOString()});

test("SQL: 原本・スペース・変更cursorを同一transactionで保存",async()=>{
  const user=await database.addUser();await database.apply(user,spaceOperation());
  const op=noteOperation(undefined,"本文",null,["daily"]);const result=await database.apply(user,op);
  assert.equal(result.status,"applied");assert.equal(result.record.ownerId,user);assert.equal(result.record.body,"本文");assert.equal(result.record.serverRevision,1);
  assert.deepEqual(result.record.spaceIds,["daily"]);
  const pulled=await database.pull(user);assert.equal(pulled.changes.length,2);assert.equal(pulled.cursor,"2");assert.equal(pulled.hasMore,false);
});
test("SQL: 再送は同じ結果を返し、IDの内容変更は拒否",async()=>{
  const user=await database.addUser();const op=noteOperation();const first=await database.apply(user,op);
  assert.deepEqual(await database.apply(user,op),first);assert.equal((await database.pull(user)).changes.length,1);
  await assert.rejects(database.apply(user,{...op,payload:{...op.payload,body:"IDを悪用"}}),/different content/);
  assert.equal((await database.pull(user)).changes.length,1);
});
test("SQL: 同じ初期スペースを2端末で作っても競合しない",async()=>{
  const user=await database.addUser();const first=await database.apply(user,spaceOperation());const second=await database.apply(user,spaceOperation());
  assert.equal(second.status,"applied");assert.equal(second.record.serverRevision,first.record.serverRevision);assert.equal((await database.pull(user)).changes.length,1);
});
test("SQL: 古いrevisionとその後続操作は両方の本文を残して競合",async()=>{
  const user=await database.addUser();const original=noteOperation();await database.apply(user,original);
  const remote=noteOperation(original.entityId,"端末Bの本文",1);await database.apply(user,remote);
  const stale=noteOperation(original.entityId,"端末Aの本文",1);const conflict=await database.apply(user,stale);
  assert.equal(conflict.status,"conflict");assert.equal(conflict.record.body,"端末Bの本文");assert.ok(conflict.conflictId);
  const later={...noteOperation(original.entityId,"端末Aの続き",1),previousOperationId:stale.id};
  assert.equal((await database.apply(user,later)).status,"conflict");
  const copies=await database.queryAs(user,"select local_record,server_record from public.sync_conflicts order by created_at");
  assert.equal(copies.rows.length,2);assert.equal((copies.rows[0].local_record as Record<string,unknown>).body,"端末Aの本文");
  assert.equal((copies.rows[1].local_record as Record<string,unknown>).body,"端末Aの続き");
  assert.deepEqual(await database.apply(user,stale),conflict);assert.equal((await database.pull(user)).changes.length,2);
});
test("SQL: 同一端末で積んだ変更は前のoperationのrevisionに連結",async()=>{
  const user=await database.addUser();const first=noteOperation();await database.apply(user,first);
  const second={...noteOperation(first.entityId,"二つ目の本文"),previousOperationId:first.id};
  const third={...noteOperation(first.entityId,"三つ目の本文"),previousOperationId:second.id};
  assert.equal((await database.apply(user,second)).record.serverRevision,2);assert.equal((await database.apply(user,third)).record.serverRevision,3);
  const wrong={...noteOperation(),previousOperationId:first.id};await assert.rejects(database.apply(user,wrong),/Previous operation/);
});
test("SQL: ごみ箱への移動と復元を変更履歴に含める",async()=>{
  const user=await database.addUser();const first=noteOperation();await database.apply(user,first);
  const deletion=noteOperation(first.entityId,"元の本文",1);deletion.payload.deletedAt="2026-10-28T02:00:00.000Z";
  assert.ok((await database.apply(user,deletion)).record.deletedAt);
  const restore=noteOperation(first.entityId,"元の本文",2);assert.equal((await database.apply(user,restore)).record.deletedAt,null);
  const changes=(await database.pull(user)).changes;assert.equal(changes.length,3);assert.ok(changes[1].record.deletedAt);assert.equal(changes[2].record.deletedAt,null);
});
test("SQL: ページングcursorは文字列でowner別に順序を保つ",async()=>{
  const user=await database.addUser(),other=await database.addUser();
  await database.apply(user,noteOperation());await database.apply(other,noteOperation());await database.apply(user,noteOperation());await database.apply(user,noteOperation());
  const one=await database.pull(user,"0",2);assert.deepEqual(one.changes.map(c=>c.cursor),["1","2"]);assert.equal(one.cursor,"2");assert.equal(one.hasMore,true);
  const two=await database.pull(user,one.cursor,2);assert.deepEqual(two.changes.map(c=>c.cursor),["3"]);assert.equal(two.hasMore,false);
  assert.equal((await database.pull(other)).cursor,"1");
  await assert.rejects(database.pull(user,"-1"),/Invalid cursor/);
});
test("SQL: 外側のtransaction失敗は原本・operation・cursorをすべて戻す",async()=>{
  const user=await database.addUser();const op=noteOperation();
  await assert.rejects(database.asUser(user,async tx=>{await tx.query("select public.apply_sync_operation($1::jsonb)",[JSON.stringify(op)]);throw new Error("simulated disconnect before commit");}));
  assert.equal((await database.pull(user)).changes.length,0);
  assert.equal((await database.apply(user,op)).record.serverRevision,1);assert.equal((await database.pull(user)).cursor,"1");
});
test("SQL/RLS: 他人のItem・Space・原文・operation・競合を読めない",async()=>{
  const a=await database.addUser(),b=await database.addUser();await database.apply(a,spaceOperation("private-space"));const op=noteOperation(undefined,"Aの秘密",null,["private-space"]);await database.apply(a,op);
  for(const table of ["items","notes","spaces","item_spaces","sync_operations","sync_changes","sync_conflicts","sync_clocks"]) {
    assert.equal((await database.queryAs(b,`select * from public.${table}`)).rows.length,0,table);
  }
  assert.equal((await database.pull(b)).changes.length,0);
  await assert.rejects(database.apply(b,noteOperation(op.entityId,"他人のIDへの更新",1)),/Entity not found/);
  await assert.rejects(database.apply(b,noteOperation(undefined,"外部space",null,["private-space"])),/Space not found/);
  await assert.rejects(database.queryAs(b,"select private._sync_note($1,$2)",[a,op.entityId]),/permission denied/);
  await assert.rejects(database.queryAs(b,"update public.items set title='stolen' where id=$1",[op.entityId]),/permission denied/);
  await assert.rejects(database.queryAs(b,"insert into public.items(owner_id,id,kind,origin_app) values($1,$2,'note','recall')",[a,crypto.randomUUID()]),/permission denied/);
  const spoof=noteOperation();spoof.payload.ownerId=a;const own=await database.apply(b,spoof);assert.equal(own.record.ownerId,b);
});
test("SQL/RLS: Relation・AssetはRPCを通す必要があり直接書き換えできない",async()=>{
  const a=await database.addUser(),b=await database.addUser();const first=noteOperation(),second=noteOperation(),foreign=noteOperation();
  await database.apply(a,first);await database.apply(a,second);await database.apply(b,foreign);
  const relationId=crypto.randomUUID();await database.db.query("insert into public.relations(owner_id,id,from_item_id,to_item_id,relation_type) values($1,$2,$3,$4,'inspired_by')",[a,relationId,first.entityId,second.entityId]);
  assert.equal((await database.queryAs(b,"select * from public.relations")).rows.length,0);
  await assert.rejects(database.queryAs(a,"insert into public.relations(owner_id,from_item_id,to_item_id,relation_type) values($1,$2,$3,'inspired_by')",[a,first.entityId,foreign.entityId]),/permission denied/);
  await assert.rejects(database.queryAs(a,"update public.relations set owner_id=$1 where id=$2",[b,relationId]),/permission denied/);
  await assert.rejects(database.queryAs(a,"insert into public.assets(owner_id,item_id,storage_path,mime_type,size_bytes) values($1,$2,$3,'image/png',10)",[a,foreign.entityId,`${a}/${foreign.entityId}/x.png`]),/permission denied/);
});
test("SQL/RLS: private Storageの所有者以外は読取・挿入・移動ができない",async()=>{
  const a=await database.addUser(),b=await database.addUser();const note=noteOperation();await database.apply(a,note);
  const path=`${a}/${note.entityId}/original.png`;const row=await database.queryAs(a,"insert into storage.objects(bucket_id,name,owner_id) values('personal-tools-private',$1,$2) returning id",[path,a]);
  assert.equal((await database.queryAs(b,"select * from storage.objects")).rows.length,0);
  await assert.rejects(database.queryAs(b,"insert into storage.objects(bucket_id,name,owner_id) values('personal-tools-private',$1,$2)",[path,b]),/row-level security/);
  await assert.rejects(database.queryAs(a,"update storage.objects set name=$1 where id=$2",[`${b}/${note.entityId}/moved.png`,row.rows[0].id]),/row-level security/);
  assert.equal((await database.queryAs(a,"select * from storage.objects")).rows.length,1);
  const bucket=await database.db.query("select public from storage.buckets where id='personal-tools-private'");assert.equal(bucket.rows[0].public,false);
});
test("SQL/RLS: 未認証からRPCとデータへアクセスできない",async()=>{
  await assert.rejects(database.queryAs(null,"select public.apply_sync_operation($1::jsonb)",[JSON.stringify(noteOperation())]),/permission denied/);
  await assert.rejects(database.queryAs(null,"select public.pull_sync_changes('0',100)"),/permission denied/);
  await assert.rejects(database.queryAs(null,"select * from public.items"),/permission denied/);
});
test("SQL: 公開RPCはinvokerで、definer実装とreadersは非公開schemaに限定",async()=>{
  const functions=await database.db.query(`
    select n.nspname as schema,p.proname,p.prosecdef,p.proconfig,
      has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
      has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private') and p.proname in ('apply_sync_operation','pull_sync_changes','_sync_note','_sync_space')
    order by n.nspname,p.proname
  `);
  const exposed=functions.rows.filter(row=>row.schema==="public"),internal=functions.rows.filter(row=>row.schema==="private");
  assert.equal(exposed.length,2);assert.equal(internal.length,4);
  for(const row of exposed) {assert.equal(row.prosecdef,false);assert.equal(row.anon_execute,false);assert.equal(row.authenticated_execute,true);}
  for(const row of internal) {
    assert.equal(row.anon_execute,false);
    if(String(row.proname).startsWith("_sync")){assert.equal(row.authenticated_execute,false);}
    else {assert.equal(row.prosecdef,true);assert.equal(row.authenticated_execute,true);}
    assert.ok((row.proconfig as string[]).some(value=>value==='search_path=""'));
  }
  const access=await database.db.query("select has_schema_privilege('anon','private','USAGE') as anon_usage,has_schema_privilege('authenticated','private','CREATE') as auth_create");
  assert.equal(access.rows[0].anon_usage,false);assert.equal(access.rows[0].auth_create,false);
  await assert.rejects(database.queryAs(null,"select private.pull_sync_changes('0',100)"),/permission denied/);
  const assetIndexes=await database.db.query("select indexdef from pg_indexes where schemaname='public' and tablename='assets' and indexname='assets_by_item'");
  assert.match(String(assetIndexes.rows[0]?.indexdef),/\(owner_id, item_id\)/);
});
