import "fake-indexeddb/auto";
import test,{before,after,type TestContext} from "node:test";
import assert from "node:assert/strict";
import {openRecallRepository,openAccountRecallRepository,createSupabaseSyncTransport,createSyncEngine,
  prepareResourceImage,uploadResourceOriginal,downloadResourceOriginal,getResourceStoragePath,
  type ResourceOriginalClient,type AccountRecallRepository,type SaveResourceInput} from "../packages/api-client/src/index.ts";
import {parseCollectBackup,resourceUrl,emptyResourceMetadata,type Resource,type SyncOperation} from "../packages/core/src/index.ts";
import {createTestDatabase} from "./helpers/database.ts";

let database:Awaited<ReturnType<typeof createTestDatabase>>;
before(async()=>{database=await createTestDatabase();});
after(async()=>{await database?.close();});
const name=()=>`collect-test-${crypto.randomUUID()}`;
// A real bounded PNG; the exact original bytes, rather than a preview, are hashed.
const png=()=>new Blob([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="),char=>char.charCodeAt(0))],{type:"image/png"});
const link=(title="資料",url="https://example.com/article#one"):SaveResourceInput=>({resourceType:"link",url,sourceUrl:"",title,memo:"自分のメモ",spaceIds:[],inbox:true,image:null});
async function device(t:TestContext,owner:string){const repo=await openAccountRecallRepository(owner,{name:name()});t.after(()=>repo.close());return repo;}
function transport(owner:string){return createSupabaseSyncTransport({async rpc(method,args){try{return {data:method==="apply_sync_operation"?await database.apply(owner,args.p_operation):await database.pullTools(owner,String(args.p_cursor),Number(args.p_limit)),error:null};}catch(error){return {data:null,error:{message:String(error)}};}}},owner);}
async function sync(repo:AccountRecallRepository,phase="idle"){
  const engine=createSyncEngine(repo,transport(repo.ownerId));try{const state=await engine.run();assert.equal(state.phase,phase,state.error);return state;}finally{engine.stop();}
}
function operation(resource:Resource,baseRevision:number|null=resource.serverRevision):SyncOperation{return {id:crypto.randomUUID(),kind:"put_resource",entityId:resource.id,baseRevision,createdAt:new Date().toISOString(),payload:resource};}
async function storedCount(dbName:string,store:string){return new Promise<number>((resolve,reject)=>{const req=indexedDB.open(dbName);req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result,tx=db.transaction(store),read=tx.objectStore(store).count();read.onsuccess=()=>resolve(read.result);read.onerror=()=>reject(read.error);tx.oncomplete=()=>db.close();};});}

test("Collect: original image, composer and editable link survive reopening with immutable originals",async t=>{
  const dbName=name(),repo=await openRecallRepository(dbName),file=png(),image=await prepareResourceImage(file,"原本.png");
  const resource=await repo.saveResource({...link(),resourceType:"image",url:"",image,file});
  await repo.saveCollectDraft({...link("編集中"),editingId:resource.id,expectedRevision:resource.localRevision,resourceType:"image",url:"",image});
  repo.close();const restored=await openRecallRepository(dbName);t.after(()=>restored.close());
  const data=await restored.snapshot();assert.equal(data.resources.length,1);assert.equal(data.notes.length,0);assert.equal(data.sketches.length,0);
  assert.deepEqual(new Uint8Array(await (await restored.getResourceFile(resource.id))!.arrayBuffer()),new Uint8Array(await file.arrayBuffer()));
  assert.equal((await restored.loadCollectDraft()).expectedRevision,1);assert.equal((await restored.getCollectDraftFile())!.size,file.size);
  const edited=await restored.updateResource(resource.id,{title:"手動タイトル",memo:"変更",pinned:true,inbox:false},1);
  assert.equal(edited.localRevision,2);assert.deepEqual(edited.image,image);
  await assert.rejects(restored.updateResource(resource.id,{title:"古い画面"},1),/別の画面/);
  await assert.rejects(restored.saveResource({...edited,url:"",sourceUrl:"",resourceType:"link",image:null},2),/新しい資料/);
  await assert.rejects(restored.saveResource({...edited,url:"",sourceUrl:"",image:{...image,filename:"changed.png"}},2),/新しい資料/);
  const withUrl=await restored.updateResource(resource.id,{url:"https://example.com/image"},2);
  assert.equal((await restored.updateResource(resource.id,{url:null},withUrl.localRevision)).url,null);
});

test("Collect: quota failure rolls back original, resource, draft clearing and sync outbox together",async t=>{
  const dbName=name(),owner=await database.addUser(),repo=await openAccountRecallRepository(owner,{name:dbName});t.after(()=>repo.close());
  await repo.saveCollectDraft(link("残す下書き"));const pending=(await repo.pendingOperations()).length;
  const add=IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add=function(value:unknown,key?:IDBValidKey){if(this.name==="syncOutbox"&&(value as {kind?:string}).kind==="put_resource")throw new DOMException("Full","QuotaExceededError");return add.call(this,value,key);};
  try{await assert.rejects(repo.saveResource({...link(),resourceType:"image",url:"",image:await prepareResourceImage(png()),file:png()}),/Full/);}finally{IDBObjectStore.prototype.add=add;}
  assert.equal((await repo.snapshot()).resources.length,0);assert.equal(await storedCount(dbName,"resourceFiles"),0);
  assert.equal((await repo.pendingOperations()).length,pending);assert.equal((await repo.loadCollectDraft()).title,"残す下書き");
});

test("Collect: draft validation and canonical duplicate hints preserve existing records",async t=>{
  const repo=await openRecallRepository(name());t.after(()=>repo.close());
  const first=await repo.saveResource(link());assert.equal((await repo.duplicateResources({url:"https://example.com/article#two"}))[0].id,first.id);
  assert.equal((await repo.duplicateResources({url:first.url},first.id)).length,0);
  await repo.saveResource(link("duplicate allowed"));assert.equal((await repo.snapshot()).resources.length,2);
  await assert.rejects(repo.saveResource({...link(),url:"javascript:alert(1)"}));
  await assert.rejects(repo.saveResource({...link(),spaceIds:["missing"]}));
  await assert.rejects(repo.saveCollectDraft({...link(),resourceType:"image",image:await prepareResourceImage(png())}));
  assert.equal((await repo.snapshot()).resources.length,2);assert.throws(()=>resourceUrl("https://user:pass@example.com"));
});

test("Collect metadata: token CAS retains manual fields and ignores obsolete URL, retry and trash results",async t=>{
  const repo=await openRecallRepository(name());t.after(()=>repo.close());
  let resource=await repo.saveResource(link());const first=await repo.startResourceMetadata(resource.id,resource.localRevision);
  resource=(await repo.snapshot()).resources[0];resource=await repo.updateResource(resource.id,{title:"自分のタイトル",memo:"自分の文章",sourceUrl:"https://source.example/",inbox:false},resource.localRevision);
  const ready=await repo.finishResourceMetadata(resource.id,first.token,{title:"サイトのタイトル",description:"取得説明"});
  assert.equal(ready!.title,"自分のタイトル");assert.equal(ready!.memo,"自分の文章");assert.equal(ready!.sourceUrl,"https://source.example/");assert.equal(ready!.inbox,false);assert.equal(ready!.metadata.status,"ready");
  assert.equal(await repo.finishResourceMetadata(resource.id,first.token,null),null);
  const retry=await repo.startResourceMetadata(resource.id,ready!.localRevision);resource=(await repo.snapshot()).resources[0];
  const newer=await repo.startResourceMetadata(resource.id,resource.localRevision);assert.equal(await repo.finishResourceMetadata(resource.id,retry.token,null),null);
  resource=(await repo.snapshot()).resources[0];resource=await repo.updateResource(resource.id,{url:"https://example.com/new"},resource.localRevision);
  assert.equal(await repo.finishResourceMetadata(resource.id,newer.token,{title:"古いURL",description:"old"}),null);assert.equal(resource.metadata.status,"none");
  const trashJob=await repo.startResourceMetadata(resource.id,resource.localRevision);resource=(await repo.snapshot()).resources[0];await repo.updateResource(resource.id,{deletedAt:new Date().toISOString()},resource.localRevision);
  assert.equal(await repo.finishResourceMetadata(resource.id,trashJob.token,null),null);assert.equal(await repo.getResourceMetadataJob(resource.id),null);
});

test("Collect backup: portable round trip includes originals, rekeys spaces, validates bytes before any writes",async t=>{
  const source=await openRecallRepository(name()),target=await openRecallRepository(name());t.after(()=>source.close());t.after(()=>target.close());
  const image=await prepareResourceImage(png(),"camera.png"),resource=await source.saveResource({...link(),resourceType:"image",url:"",spaceIds:["research"],image,file:png()});
  const url=await source.saveResource(link());await source.startResourceMetadata(url.id,url.localRevision);
  const backup=await source.exportCollectBackup();assert.equal(backup.files.length,1);assert.ok(backup.resources.every(r=>r.ownerId===null&&r.serverRevision===null));
  assert.deepEqual(parseCollectBackup(JSON.parse(JSON.stringify(backup))),backup);
  await assert.rejects(target.importCollectBackup({...backup,files:[]}));
  await assert.rejects(target.importCollectBackup({...backup,files:[{...backup.files[0],sha256:"a".repeat(64)}]}));
  await assert.rejects(target.importCollectBackup({...backup,files:[{...backup.files[0],data:"A"+backup.files[0].data.slice(1)}]}));
  assert.equal((await target.snapshot()).resources.length,0);
  const result=await target.importCollectBackup(backup);assert.equal(result.resources,2);
  const data=await target.snapshot(),restored=data.resources.find(r=>r.image)!;assert.notEqual(restored.id,resource.id);assert.notEqual(restored.spaceIds[0],"research");
  assert.equal(data.spaces.find(s=>s.id===restored.spaceIds[0])!.name,"研究");assert.equal(data.resources.find(r=>r.resourceType==="link")!.metadata.status,"none");
  assert.deepEqual(new Uint8Array(await (await target.getResourceFile(restored.id))!.arrayBuffer()),new Uint8Array(await png().arrayBuffer()));
  assert.equal((await source.snapshot()).resources.length,2);
});

test("Collect backup: aggregate originals have a32MB limit and input JSON has a64MB limit",async t=>{
  const repo=await openRecallRepository(name());t.after(()=>repo.close());const resource=await repo.saveResource(link()),backup=await repo.exportCollectBackup();
  const size=17*1024*1024,data="A".repeat(4*Math.ceil(size/3)-1)+"=";
  const files=["a","b"].map(letter=>({sha256:letter.repeat(64),mimeType:"image/png",size,filename:"large.png",data}));
  assert.throws(()=>parseCollectBackup({...backup,files}),/32MB/);
  assert.throws(()=>parseCollectBackup({...backup,extra:"x".repeat(64*1024*1024)}),/64MB/);
  assert.equal((await repo.snapshot()).resources[0].id,resource.id);
});

test("Collect image validation: MIME, dimensions, signatures, limits and SHA256 are verified",async()=>{
  const image=await prepareResourceImage(png(),"one.png");assert.equal(image.sha256.length,64);assert.equal(image.mimeType,"image/png");
  assert.equal(image.sha256,(await prepareResourceImage(png(),"two.png")).sha256);
  await assert.rejects(prepareResourceImage(new Blob([await png().arrayBuffer()],{type:"image/jpeg"})),/種類と内容/);
  await assert.rejects(prepareResourceImage(new Blob(["<svg>bad</svg>"],{type:"image/svg+xml"})));
  await assert.rejects(prepareResourceImage(new Blob([new Uint8Array(20*1024*1024+1)])),/20MB/);
  const oversized=new Uint8Array(await png().arrayBuffer());new DataView(oversized.buffer).setUint32(16,30000);
  await assert.rejects(prepareResourceImage(new Blob([oversized],{type:"image/png"})),/4,000万/);
});

test("Collect accounts: device data is imported explicitly and separate owners cannot reuse a cache",async t=>{
  const local=await openRecallRepository(name());t.after(()=>local.close());const image=await prepareResourceImage(png());await local.saveResource({...link(),resourceType:"image",url:"",image,file:png()});
  const owner=await database.addUser(),other=await database.addUser(),dbName=name(),account=await openAccountRecallRepository(owner,{name:dbName});t.after(()=>account.close());
  assert.equal((await account.snapshot()).resources.length,0);
  await account.importCollectBackup(await local.exportCollectBackup());assert.equal((await account.snapshot()).resources.length,1);assert.equal((await local.snapshot()).resources.length,1);
  await assert.rejects(openAccountRecallRepository(other,{name:dbName}),/別のアカウント/);
  const second=await device(t,other);assert.equal((await second.snapshot()).resources.length,0);
});

test("Collect SQL: original metadata, offline chains, idempotence, deletion and restoration sync between independent caches",async t=>{
  const owner=await database.addUser(),a=await device(t,owner),b=await device(t,owner),image=await prepareResourceImage(png());
  let resource=await a.saveResource({...link(),resourceType:"image",url:"",spaceIds:["research"],image,file:png()});
  resource=await a.updateResource(resource.id,{title:"第二版"},resource.localRevision);await a.updateResource(resource.id,{memo:"第三版"},resource.localRevision);
  const ops=(await a.pendingOperations()).filter(op=>op.kind==="put_resource");assert.equal(ops.length,3);assert.equal(ops[1].previousOperationId,ops[0].id);
  await sync(a);await sync(b);resource=(await b.snapshot()).resources[0];assert.equal(resource.serverRevision,3);assert.equal(resource.memo,"第三版");assert.deepEqual(resource.image,image);
  assert.equal(await b.getResourceFile(resource.id),null);await b.cacheResourceFile(resource.id,png());
  const {sequence:_sequence,localRevision:_localRevision,...wire}=ops[0];
  const replay=await database.apply(owner,wire);assert.equal(replay.record.serverRevision,1);assert.equal((await database.pullTools(owner)).changes.filter(c=>c.entity==="resource").length,3);
  resource=await b.updateResource(resource.id,{deletedAt:new Date().toISOString()},resource.localRevision);await sync(b);await sync(a);assert.ok((await a.snapshot()).resources[0].deletedAt);
  await b.updateResource(resource.id,{deletedAt:null},resource.localRevision);await sync(b);await sync(a);assert.equal((await a.snapshot()).resources[0].deletedAt,null);
});

test("Collect SQL: concurrent edits keep newest local conflict original in backup and keep both",async t=>{
  const owner=await database.addUser(),a=await device(t,owner),b=await device(t,owner);await a.saveResource({...link(),resourceType:"image",url:"",image:await prepareResourceImage(png()),file:png()});
  await sync(a);await sync(b);let local=(await a.snapshot()).resources[0],remote=(await b.snapshot()).resources[0];
  await b.updateResource(remote.id,{title:"端末B"},remote.localRevision);await sync(b);local=await a.updateResource(local.id,{title:"端末A"},local.localRevision);await a.updateResource(local.id,{title:"端末Aの最新"},local.localRevision);
  await sync(a,"conflict");const backup=await a.exportCollectBackup();assert.deepEqual(backup.resources.map(r=>r.title).sort(),["端末Aの最新","端末B"].sort());assert.equal(backup.files.length,1);
  await a.resolveConflict((await a.getSyncState()).conflicts[0].id,"keep_both");await sync(a);await sync(b);assert.deepEqual((await b.snapshot()).resources.map(r=>r.title).sort(),["端末Aの最新","端末B"].sort());
});

test("Collect sync race: a newer deferred remote survives an older in-flight acknowledgment",async t=>{
  const owner=await database.addUser(),repo=await device(t,owner);let resource=await repo.saveResource(link());await sync(repo);
  resource=(await repo.snapshot()).resources[0];await repo.updateResource(resource.id,{memo:"local edit"},resource.localRevision);
  const op=(await repo.pendingOperations()).find(op=>op.kind==="put_resource")!,accepted=await database.apply(owner,op);
  const remote=await database.apply(owner,operation({...accepted.record as unknown as Resource,title:"newer remote"},Number(accepted.record.serverRevision)));
  await repo.acceptPull(await database.pullTools(owner,(await repo.getSyncState()).cursor) as never);
  assert.equal((await repo.snapshot()).resources[0].memo,"local edit");
  await repo.acceptPush(op,accepted as never);assert.equal((await repo.snapshot()).resources[0].title,"newer remote");assert.equal((await repo.snapshot()).resources[0].serverRevision,remote.record.serverRevision);
  assert.equal((await repo.getSyncState()).pending,0);
});

test("Collect SQL: v2 and v3 streams hide resources, full stream paginates through every entity",async t=>{
  const owner=await database.addUser(),repo=await device(t,owner);await repo.saveResource(link());await repo.saveNote({body:"Recall",spaceIds:[]});await repo.saveSketch({title:"Sketchbook",strokes:[],spaceIds:[]});await sync(repo);
  const recall=await database.pull(owner),suite=await database.pullSuite(owner);assert.ok(recall.changes.every(c=>["note","space"].includes(c.entity)));assert.ok(suite.changes.some(c=>c.entity==="sketch"));assert.ok(suite.changes.every(c=>String(c.entity)!=="resource"));
  const all=[];let cursor="0",more=true,pages=0;while(more){assert.ok(++pages<20,"pagination must advance");const page=await database.pullTools(owner,cursor,1);assert.equal(page.changes.length,1);assert.ok(BigInt(page.cursor)>BigInt(cursor));all.push(...page.changes);cursor=page.cursor;more=page.hasMore;}
  assert.ok(all.some(c=>c.entity==="resource"));assert.equal((await database.pullTools(owner,cursor)).hasMore,false);
  const empty=await database.pullSuite(owner,suite.cursor);assert.equal(empty.hasMore,false);assert.equal(empty.changes.length,0);
});

test("Collect SQL: owner RLS, original immutability and malformed inputs are enforced",async t=>{
  const owner=await database.addUser(),other=await database.addUser(),repo=await device(t,owner);await repo.saveResource({...link(),resourceType:"image",url:"",image:await prepareResourceImage(png()),file:png()});await sync(repo);
  const resource=(await repo.snapshot()).resources[0];assert.equal((await database.queryAs(other,"select * from public.resources")).rows.length,0);
  await assert.rejects(database.queryAs(null,"select * from public.resources"),/permission denied/);
  await assert.rejects(database.queryAs(owner,"update public.resources set memo='direct'"),/permission denied/);
  await assert.rejects(database.queryAs(owner,"select private._sync_resource($1,$2)",[other,resource.id]),/permission denied/);
  await assert.rejects(database.apply(owner,operation({...resource,resourceType:"link",image:null,url:"https://example.com/"})),/cannot change/);
  await assert.rejects(database.apply(owner,operation({...resource,image:{...resource.image!,sha256:"f".repeat(64)}})),/cannot change/);
  for(const bad of [{...resource,sourceUrl:"file:///tmp/a"},{...resource,spaceIds:[123]},{...resource,image:{...resource.image!,size:68.5}},{...resource,metadata:{...emptyResourceMetadata(),title:1}},{...resource,createdAt:null}])await assert.rejects(database.apply(owner,operation(bad as Resource)));
  assert.equal((await database.queryAs(owner,"select * from public.resources")).rows.length,1);
  const stolen=await database.apply(other,operation(resource,null));assert.equal(stolen.record.ownerId,other);assert.equal((await database.queryAs(other,"select * from public.resources")).rows.length,1);
});

test("Collect original SQL: only owner canonical private original can register, trash keeps it immutable",async t=>{
  const owner=await database.addUser(),other=await database.addUser(),repo=await device(t,owner);await repo.saveResource({...link(),resourceType:"image",url:"",image:await prepareResourceImage(png()),file:png()});await sync(repo);
  let resource=(await repo.snapshot()).resources[0];const path=getResourceStoragePath(owner,resource),args=[resource.id,path,resource.image!.sha256,resource.image!.mimeType,resource.image!.size];
  const get=async(user=owner)=>(await database.queryAs(user,"select public.get_resource_original($1) as result",[resource.id])).rows[0].result as {registered:boolean}|null;
  assert.equal(await get(),null);await assert.rejects(database.queryAs(owner,"select public.register_resource_original($1,$2,$3,$4,$5)",args),/upload not found/);
  await assert.rejects(database.queryAs(other,"insert into storage.objects(bucket_id,name,owner_id,metadata) values('personal-tools-private',$1,$2,$3)",[path,other,{size:png().size,mimetype:"image/png"}]),/row-level security/);
  await database.queryAs(owner,"insert into storage.objects(bucket_id,name,owner_id,metadata) values('personal-tools-private',$1,$2,$3)",[path,owner,{size:png().size,mimetype:"image/png"}]);
  await assert.rejects(database.queryAs(owner,"select public.register_resource_original($1,$2,$3,$4,$5)",[resource.id,path,resource.image!.sha256,"image/jpeg",png().size]),/changed/);
  await assert.rejects(database.queryAs(owner,"select public.register_resource_original($1,$2,$3,$4,$5)",[resource.id,path,resource.image!.sha256,"image/png",png().size+1]),/changed/);
  assert.equal((await get())!.registered,false);await database.queryAs(owner,"select public.register_resource_original($1,$2,$3,$4,$5)",args);assert.equal((await get())!.registered,true);
  await database.queryAs(owner,"select public.register_resource_original($1,$2,$3,$4,$5)",args);assert.equal((await database.queryAs(owner,"select * from public.assets where item_id=$1",[resource.id])).rows.length,1);
  await assert.rejects(get(other),/not found/);await assert.rejects(database.queryAs(null,"select public.get_resource_original($1)",[resource.id]),/permission denied/);
  assert.equal((await database.queryAs(owner,"update storage.objects set metadata='{}' where name=$1 returning *",[path])).rows.length,0);
  assert.equal((await database.queryAs(owner,"delete from storage.objects where name=$1 returning *",[path])).rows.length,0);
  resource=await repo.updateResource(resource.id,{deletedAt:new Date().toISOString()},resource.localRevision);await sync(repo);assert.equal((await get())!.registered,true);
  await assert.rejects(database.queryAs(owner,"select public.register_resource_original($1,$2,$3,$4,$5)",args),/not found/);
  await repo.updateResource(resource.id,{deletedAt:null},resource.localRevision);await sync(repo);await database.queryAs(owner,"select public.register_resource_original($1,$2,$3,$4,$5)",args);
});

async function canonicalImage(t:TestContext){const repo=await openRecallRepository(name());t.after(()=>repo.close());const resource=await repo.saveResource({...link(),resourceType:"image",url:"",image:await prepareResourceImage(png()),file:png()});const owner=crypto.randomUUID();return {owner,resource:{...resource,ownerId:owner,serverRevision:1}};}
type AdapterError={message?:string;statusCode?:string|number;status?:number;code?:string;error?:string};
function originalClient(resource:Resource,owner:string,options:{known?:"registered"|"unregistered"|"missing";uploadError?:AdapterError;registrationError?:boolean;onGet?:()=>void;onUpload?:()=>void;download?:Blob}={}){
  const calls:string[]=[],path=getResourceStoragePath(owner,resource);
  const client:ResourceOriginalClient={storage:{from(bucket){assert.equal(bucket,"personal-tools-private");return {
    async upload(actual,_body,opts){calls.push("upload");assert.equal(actual,path);assert.equal(opts.upsert,false);options.onUpload?.();return {data:{},error:options.uploadError??null};},
    async download(actual){calls.push("download");assert.equal(actual,path);return {data:options.download??png(),error:null};},
    async remove(){calls.push("remove");return {data:{},error:null};}
  };}},async rpc(method){calls.push(method);if(method==="get_resource_original"){options.onGet?.();return {data:options.known&&options.known!=="missing"?{path,sha256:resource.image!.sha256,size:resource.image!.size,mimeType:resource.image!.mimeType,registered:options.known==="registered"}:null,error:null};}return {data:{path},error:options.registrationError?{message:"reply lost"}:null};}};
  return {client,calls,path};
}

test("Collect original adapter: registered preflight skips upload and unregistered object only retries registration",async t=>{
  const {owner,resource}=await canonicalImage(t),registered=originalClient(resource,owner,{known:"registered"});
  assert.equal(await uploadResourceOriginal(registered.client,owner,resource,png()),registered.path);assert.deepEqual(registered.calls,["get_resource_original"]);
  const pending=originalClient(resource,owner,{known:"unregistered"});await uploadResourceOriginal(pending.client,owner,resource,png());assert.deepEqual(pending.calls,["get_resource_original","register_resource_original"]);
});

test("Collect original adapter: legacy400 and current409 duplicates register without overwriting",async t=>{
  const {owner,resource}=await canonicalImage(t);
  for(const error of [{statusCode:"400",error:"Duplicate",message:"The resource already exists"},{status:409,code:"ResourceAlreadyExists"},{status:409,error:"KeyAlreadyExists"}]){
    const adapter=originalClient(resource,owner,{uploadError:error});await uploadResourceOriginal(adapter.client,owner,resource,png());assert.deepEqual(adapter.calls,["get_resource_original","upload","register_resource_original"]);
  }
  for(const error of [{status:400,message:"Invalid request"},{status:409,message:"Wrong conflict"},{status:403,message:"Forbidden"}]){
    const adapter=originalClient(resource,owner,{uploadError:error});await assert.rejects(uploadResourceOriginal(adapter.client,owner,resource,png()));assert.deepEqual(adapter.calls,["get_resource_original","upload"]);
  }
  const uncertain=originalClient(resource,owner,{registrationError:true});await assert.rejects(uploadResourceOriginal(uncertain.client,owner,resource,png()));assert.equal(uncertain.calls.includes("remove"),false);
});

test("Collect original adapter: private download verifies bytes, allows trash and rejects other owner",async t=>{
  const {owner,resource}=await canonicalImage(t),adapter=originalClient(resource,owner,{known:"registered"});
  assert.equal((await downloadResourceOriginal(adapter.client,owner,{...resource,deletedAt:new Date().toISOString()})).size,png().size);
  await assert.rejects(downloadResourceOriginal(adapter.client,crypto.randomUUID(),resource));
  const invalid=originalClient(resource,owner,{known:"registered",download:new Blob(["not an image"])});await assert.rejects(downloadResourceOriginal(invalid.client,owner,resource));
  const missing=originalClient(resource,owner);await assert.rejects(downloadResourceOriginal(missing.client,owner,resource));
});

test("Collect original adapter: scope changes stop later upload, registration and download operations",async t=>{
  const {owner,resource}=await canonicalImage(t);let current=true;
  const beforeUpload=originalClient(resource,owner,{onGet(){current=false;}});await assert.rejects(uploadResourceOriginal(beforeUpload.client,owner,resource,png(),{isCurrent:()=>current}),{name:"AbortError"});assert.deepEqual(beforeUpload.calls,["get_resource_original"]);
  current=true;const beforeRegister=originalClient(resource,owner,{onUpload(){current=false;}});await assert.rejects(uploadResourceOriginal(beforeRegister.client,owner,resource,png(),{isCurrent:()=>current}),{name:"AbortError"});assert.deepEqual(beforeRegister.calls,["get_resource_original","upload"]);
  current=true;const beforeDownload=originalClient(resource,owner,{known:"registered",onGet(){current=false;}});await assert.rejects(downloadResourceOriginal(beforeDownload.client,owner,resource,{isCurrent:()=>current}),{name:"AbortError"});assert.deepEqual(beforeDownload.calls,["get_resource_original"]);
  const controller=new AbortController();controller.abort();await assert.rejects(uploadResourceOriginal(beforeUpload.client,owner,resource,png(),{signal:controller.signal}),{name:"AbortError"});
});

test("Collect upgrade: v3 notes, sketches, relations, composer and pending operations survive full resource replay",async t=>{
  const owner=await database.addUser(),source=await device(t,owner);await source.saveResource(link("hidden from v3"));const note=await source.saveNote({body:"v3 note",spaceIds:[]}),sketch=await source.saveSketch({title:"v3 sketch",strokes:[],spaceIds:[]});await source.saveRelation({fromItemId:sketch.id,toItemId:note.id,type:"inspired_by"});await sync(source);
  const snapshot=await source.snapshot(),legacy=await database.pullSuite(owner),dbName=name();
  const oldDb=await new Promise<IDBDatabase>((resolve,reject)=>{const req=indexedDB.open(dbName,3);req.onupgradeneeded=()=>{for(const store of ["notes","spaces","sketches","relations","outbox","drafts","syncOutbox","conflicts","meta"])req.result.createObjectStore(store,{keyPath:"id"});};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
  await new Promise<void>((resolve,reject)=>{const tx=oldDb.transaction(["notes","spaces","sketches","relations","drafts","syncOutbox","meta"],"readwrite");for(const note of snapshot.notes)tx.objectStore("notes").put(note);for(const sketch of snapshot.sketches)tx.objectStore("sketches").put(sketch);for(const relation of snapshot.relations)tx.objectStore("relations").put(relation);for(const space of snapshot.spaces)tx.objectStore("spaces").put(space);
    tx.objectStore("drafts").put({id:"composer",body:"旧下書き",spaceIds:[]});tx.objectStore("drafts").put({id:"sketch-composer",title:"旧スケッチ下書き",strokes:[],spaceIds:[]});
    for(const entry of [{id:"identity",value:owner},{id:"seeded",value:true},{id:"cursor",value:legacy.cursor},{id:"sequence",value:1}])tx.objectStore("meta").put(entry);
    const pending={...snapshot.notes[0],id:crypto.randomUUID(),body:"未送信",serverRevision:null};tx.objectStore("notes").put(pending);tx.objectStore("syncOutbox").put({id:crypto.randomUUID(),kind:"put_note",entityId:pending.id,baseRevision:null,payload:pending,createdAt:new Date().toISOString(),sequence:1,localRevision:1});
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);
  });oldDb.close();const upgraded=await openAccountRecallRepository(owner,{name:dbName});t.after(()=>upgraded.close());
  assert.equal((await upgraded.getSyncState()).cursor,"0");assert.equal((await upgraded.pendingOperations()).length,1);assert.equal((await upgraded.loadDraft()).body,"旧下書き");assert.equal((await upgraded.loadSketchDraft()).title,"旧スケッチ下書き");assert.equal((await upgraded.snapshot()).sketches.length,1);assert.equal((await upgraded.snapshot()).relations.length,1);
  await sync(upgraded);assert.equal((await upgraded.snapshot()).resources[0].title,"hidden from v3");assert.equal((await upgraded.snapshot()).notes.length,2);assert.equal((await upgraded.snapshot()).sketches.length,1);assert.equal((await upgraded.snapshot()).relations.length,1);
});
