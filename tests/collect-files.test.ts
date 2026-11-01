import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {openRecallRepository,openAccountRecallRepository,prepareResourceFile,uploadEncryptedResourceOriginal,downloadEncryptedResourceOriginal,createEncryptedSyncTransport,createSyncEngine,type SaveResourceInput} from "../packages/api-client/src/index.ts";
import {atlasText,parseCollectBackup,resourceOriginal,type ResourceDrive} from "../packages/core/src/index.ts";
import {retentionMetadata} from "../packages/api-client/src/vault-retention.ts";

const name=()=>`collect-files-${crypto.randomUUID()}`;
const base=():SaveResourceInput=>({resourceType:"text",url:"",sourceUrl:"",title:"文章",text:"収集した本文",memo:"金庫内の追記",spaceIds:[],inbox:true,image:null});
const reference=(status:ResourceDrive["status"]="pending"):ResourceDrive=>({fileId:"drive-original-id",folderId:"drive-folder-id",accountId:"account-id",marker:crypto.randomUUID(),name:"原本.txt",mimeType:"text/plain",size:5,version:"1",modifiedTime:null,status,checkedAt:new Date().toISOString()});

test("F storage: generic original and encrypted draft survive reopen, text is searchable without becoming private memo",async t=>{
  const dbName=name(),repo=await openRecallRepository(dbName),blob=new Blob(["hello"],{type:"application/pdf"}),original=await prepareResourceFile(blob,"資料.pdf");
  await repo.saveCollectDraft({...base(),resourceType:"file",original},blob);
  repo.close();const restored=await openRecallRepository(dbName);t.after(()=>restored.close());
  assert.deepEqual((await restored.loadCollectDraft()).original,original);assert.equal(await (await restored.getCollectDraftFile())!.text(),"hello");
  const record=await restored.saveResource({...base(),resourceType:"file",original,file:blob});
  assert.equal(await (await restored.getResourceFile(record.id))!.text(),"hello");assert.equal(record.image,null);assert.deepEqual(resourceOriginal(record),original);
  const text=await restored.saveResource(base());assert.match(atlasText(text),/収集した本文/);assert.equal(text.memo,"金庫内の追記");
  const empty=new Blob([],{type:"text/plain"});assert.equal((await prepareResourceFile(empty,"empty.txt")).size,0);
});

test("F storage: batch saves preserve unrelated draft; failures roll back generic bytes and pending record",async t=>{
  const repo=await openRecallRepository(name());t.after(()=>repo.close());await repo.saveCollectDraft(base());
  const blob=new Blob(["original"],{type:"application/octet-stream"}),original=await prepareResourceFile(blob,"file.bin");
  await repo.saveResource({...base(),resourceType:"file",original,file:blob,preserveDraft:true});
  assert.equal((await repo.loadCollectDraft()).text,"収集した本文");
  const put=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(value:unknown,key?:IDBValidKey){if(this.name==="resources")throw new DOMException("Full","QuotaExceededError");return put.call(this,value,key);};
  try{await assert.rejects(repo.saveResource({...base(),resourceType:"file",original,file:blob}),/Full/);}finally{IDBObjectStore.prototype.put=put;}
  assert.equal((await repo.snapshot()).resources.length,1);assert.equal((await repo.loadCollectDraft()).text,"収集した本文");
});

test("F storage: full and reference backups are distinct, import rekeys without pretending missing bytes exist",async t=>{
  const source=await openRecallRepository(name()),target=await openRecallRepository(name());t.after(()=>source.close());t.after(()=>target.close());
  const blob=new Blob(["payload"],{type:"application/octet-stream"}),original=await prepareResourceFile(blob,"source.bin");
  const saved=await source.saveResource({...base(),resourceType:"file",original,file:blob,drive:reference("ready")});
  const full=await source.exportCollectBackup();assert.equal(full.version,2);assert.equal(full.mode,"originals");assert.equal(full.files.length,1);assert.deepEqual(parseCollectBackup(full),full);
  const refs=await source.exportCollectBackup(undefined,{mode:"references"});assert.equal(refs.mode,"references");assert.equal(refs.files.length,0);
  assert.throws(()=>parseCollectBackup({...full,files:[]}),/不足/);
  await target.importCollectBackup(refs);const referenceOnly=(await target.snapshot()).resources[0];assert.notEqual(referenceOnly.id,saved.id);assert.equal(referenceOnly.drive!.fileId,saved.drive!.fileId);assert.equal(await target.getResourceFile(referenceOnly.id),null);
  await target.importCollectBackup(full);const restored=(await target.snapshot()).resources.find(r=>r.id!==referenceOnly.id)!;assert.equal(await (await target.getResourceFile(restored.id))!.text(),"payload");
  await assert.rejects(target.importCollectBackup({...full,files:[{...full.files[0],sha256:"a".repeat(64)}]}),/不足|一致/);
});

test("F storage: durable pending reference, verified refresh and cache eviction preserve private fields and settings",async t=>{
  const repo=await openRecallRepository(name());t.after(()=>repo.close());const first=new Blob(["first"],{type:"text/plain"}),original=await prepareResourceFile(first,"原本.txt"),id=crypto.randomUUID();
  let record=await repo.saveResource({...base(),resourceType:"file",original,file:first,newId:id,drive:reference()});assert.equal(record.id,id);
  assert.equal((await repo.snapshot()).resources[0].drive!.status,"pending");await assert.rejects(repo.evictResourceFile(id),/Drive/);
  const second=new Blob(["second"],{type:"text/plain"}),next=await prepareResourceFile(second,"変更.txt");
  await assert.rejects(repo.refreshResourceOriginal(id,next,undefined,record.localRevision),/取得/);
  const ready={...record.drive!,status:"ready" as const,name:"変更.txt",size:second.size,version:"2"};
  record=await repo.refreshResourceOriginal(id,next,second,record.localRevision,ready);
  assert.equal(record.title,"文章");assert.equal(record.memo,"金庫内の追記");assert.equal(record.text,"収集した本文");assert.equal(await (await repo.getResourceFile(id))!.text(),"second");
  assert.deepEqual((await retentionMetadata(record,crypto.randomUUID())).filePaths,[]);
  await repo.evictResourceFile(id);assert.equal(await repo.getResourceFile(id),null);assert.equal((await repo.snapshot()).resources[0].drive!.status,"ready");
  await repo.saveCollectDriveSettings({folderId:"folder",folderName:"保存先",accountId:"account",target:"drive"});assert.equal((await repo.loadCollectDriveSettings())!.folderName,"保存先");await repo.saveCollectDriveSettings(null);assert.equal(await repo.loadCollectDriveSettings(),null);
});

test("F storage: vault cloud size limit rejects before atomic writes; Drive reference can retain oversized external metadata",async t=>{
  const repo=await openAccountRecallRepository(crypto.randomUUID(),{name:name()});t.after(()=>repo.close());
  const original={sha256:"a".repeat(64),filename:"large.bin",mimeType:"application/octet-stream",size:21*1024*1024};
  await assert.rejects(repo.saveResource({...base(),resourceType:"file",original}),/20MB/);assert.equal((await repo.snapshot()).resources.length,0);
  const record=await repo.saveResource({...base(),resourceType:"file",original,newId:crypto.randomUUID(),drive:reference()});assert.equal(record.drive!.status,"pending");
  assert.equal((await repo.pendingOperations()).filter(op=>op.kind==="put_resource").length,1);
  const backup=await repo.exportCollectBackup(undefined,{mode:"references"}),before=await repo.snapshot(),pending=(await repo.pendingOperations()).length;
  await assert.rejects(repo.importCollectBackup({...backup,resources:backup.resources.map(resource=>({...resource,drive:null}))}),/20MB/);
  assert.equal((await repo.pendingOperations()).length,pending);assert.deepEqual(await repo.snapshot(),before);
});

test("F storage: generic encrypted vault transfer verifies bytes and never treats Drive refs as vault paths",async t=>{
  const owner=crypto.randomUUID(),repo=await openAccountRecallRepository(owner,{name:name()});t.after(()=>repo.close());
  const blob=new Blob(["private PDF bytes"],{type:"application/pdf"}),original=await prepareResourceFile(blob,"原本.pdf");let record=await repo.saveResource({...base(),resourceType:"file",original,file:blob});
  const objects=new Map<string,Blob>();const client={async rpc(){return {data:{},error:null};},storage:{from(bucket:string){assert.equal(bucket,"personal-tools-vault");return {async upload(path:string,data:Blob){objects.set(path,data);return {data:{},error:null};},async download(path:string){return {data:objects.get(path),error:null};}};}}};
  const path=await uploadEncryptedResourceOriginal(client as never,owner,record,blob);assert.ok(!path.includes("原本.pdf"));assert.ok(!(await objects.get(path)!.text()).includes("private PDF bytes"));
  assert.equal(await (await downloadEncryptedResourceOriginal(client as never,owner,record)).text(),"private PDF bytes");assert.equal((await retentionMetadata(record,owner)).filePaths.length,1);
  record=await repo.updateResource(record.id,{drive:reference("ready")},record.localRevision);await assert.rejects(uploadEncryptedResourceOriginal(client as never,owner,record,blob),/保存先/);assert.deepEqual((await retentionMetadata(record,owner)).filePaths,[]);
});

test("F storage: encrypted sync carries generic original and Drive reference without exposing text or creating files",async t=>{
  const owner=crypto.randomUUID(),a=await openAccountRecallRepository(owner,{name:name()}),b=await openAccountRecallRepository(owner,{name:name()});t.after(()=>a.close());t.after(()=>b.close());
  const blob=new Blob(["private source"],{type:"text/plain"}),original=await prepareResourceFile(blob,"秘密の原本.txt");
  await a.saveResource({...base(),resourceType:"file",original,file:blob,drive:reference("ready")});
  const changes:any[]=[];let cursor=0;
  const client={async rpc(method:string,args:Record<string,any>){
    if(method==="push_vault_record_v2"){
      const op=args.p_operation;assert.ok(!JSON.stringify(op).includes("秘密の原本"));assert.ok(!JSON.stringify(op).includes("金庫内の追記"));
      const record={entity:op.entity,id:op.entityId,revision:1,box:op.box,retention:op.retention};changes.push({cursor:String(++cursor),entity:op.entity,record});return {error:null,data:{status:"applied",operationId:op.id,record}};
    }
    const page=changes.filter(change=>BigInt(change.cursor)>BigInt(args.p_cursor));return {error:null,data:{changes:page,cursor:String(cursor),hasMore:false}};
  }};
  for(const repo of [a,b]){const engine=createSyncEngine(repo,createEncryptedSyncTransport(client,owner));try{const status=await engine.run();assert.equal(status.phase,"idle",status.error);}finally{engine.stop();}}
  const resource=(await b.snapshot()).resources[0];assert.deepEqual(resource.original,original);assert.equal(resource.drive!.fileId,"drive-original-id");assert.equal(resource.memo,"金庫内の追記");assert.equal(await b.getResourceFile(resource.id),null);
});

test("F storage: expiry prunes unreferenced generic bytes and retains a shared original",async t=>{
  const repo=await openRecallRepository(name());t.after(()=>repo.close());const blob=new Blob(["shared"],{type:"application/octet-stream"}),original=await prepareResourceFile(blob,"shared.bin");
  const expired=await repo.saveResource({...base(),resourceType:"file",original,file:blob,deletedAt:"2020-01-01T00:00:00.000Z"});const retained=await repo.saveResource({...base(),resourceType:"file",original,file:blob});
  assert.equal(await repo.purgeExpired(true),1);assert.equal((await repo.snapshot()).resources.some(r=>r.id===expired.id),false);assert.equal(await (await repo.getResourceFile(retained.id))!.text(),"shared");
});
