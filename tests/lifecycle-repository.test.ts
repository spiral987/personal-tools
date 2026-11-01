import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {openRecallRepository,openAccountRecallRepository} from "../packages/api-client/src/repository.ts";
import {trashPurgeAt} from "../packages/core/src/index.ts";
import {PNG} from "./helpers/vault-fixtures.ts";
const project=(itemIds:string[]=[])=>({name:"共通の制作",description:"",status:"active" as const,dueDate:null,itemIds});
const resource=(spaceIds:string[]=[])=>({resourceType:"link" as const,url:"https://example.com/source",sourceUrl:"",title:"資料",memo:"原本を残す",spaceIds,inbox:true,image:null});

test("offline image expiry retains encrypted bytes for a remote restore, then permanent deletion removes them",async()=>{
 const owner=crypto.randomUUID(),name=`lifecycle-retained-file-${crypto.randomUUID()}`,repo=await openAccountRecallRepository(owner,{name});try{
  const record=await repo.saveResource({...resource(),resourceType:"image",url:"",file:new Blob([PNG],{type:"image/png"})}),op=(await repo.pendingOperations()).find(op=>op.entityId===record.id)!,canonical={...record,serverRevision:1};await repo.acceptPush(op,{status:"applied",operationId:op.id,record:canonical});
  let current=(await repo.snapshot()).resources[0];await repo.updateResource(record.id,{deletedAt:"2020-01-01T00:00:00.000Z"},current.localRevision);await repo.purgeExpired(true);assert.equal(await repo.getResourceFile(record.id),null);
  await repo.acceptPull({changes:[{entity:"resource",cursor:"1",record:canonical}],cursor:"1",hasMore:false});assert.equal((await repo.getResourceFile(record.id))?.size,PNG.byteLength);
  current=(await repo.snapshot()).resources[0];await repo.updateResource(record.id,{deletedAt:"2020-01-01T00:00:00.000Z"},current.localRevision);await repo.purgeExpired(true);
  await repo.acceptPull({changes:[],purges:[{entity:"resource",id:record.id,ownerId:owner,serverRevision:2,purgedAt:new Date().toISOString()}],cursor:"2",hasMore:false});
  const raw=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(name);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});try{assert.equal(await new Promise<number>((resolve,reject)=>{const request=raw.transaction("resourceFiles").objectStore("resourceFiles").count();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);}),0);}finally{raw.close();}
 }finally{repo.close();}
});

test("offline expiry: the server's active head survives unsent local trash, while permanent notices remain terminal",async()=>{
 const owner=crypto.randomUUID(),repo=await openAccountRecallRepository(owner,{name:`lifecycle-temporary-${crypto.randomUUID()}`});try{
  const note=await repo.saveNote({body:"サーバーの原本",spaceIds:[]}),op=(await repo.pendingOperations()).find(p=>p.entityId===note.id)!;
  const canonical={...note,serverRevision:1};await repo.acceptPush(op,{status:"applied",operationId:op.id,record:canonical});
  const current=(await repo.snapshot()).notes[0];await repo.saveNote({...current,deletedAt:"2020-01-01T00:00:00.000Z"},current.localRevision);await repo.purgeExpired(true);assert.equal((await repo.snapshot()).notes.length,0);
  await repo.acceptPull({changes:[{entity:"note",cursor:"1",record:canonical}],cursor:"1",hasMore:false});assert.equal((await repo.snapshot()).notes[0].body,canonical.body);
  await repo.acceptPull({changes:[],purges:[{entity:"note",id:note.id,ownerId:owner,serverRevision:2,purgedAt:new Date().toISOString()}],cursor:"2",hasMore:false});
  await repo.acceptPull({changes:[{entity:"note",cursor:"3",record:{...canonical,serverRevision:999}}],cursor:"3",hasMore:false});assert.equal((await repo.snapshot()).notes.length,0);
 }finally{repo.close();}
});
test("projects: all tools use one shared membership graph and project deletion preserves originals",async()=>{
 const name=`lifecycle-projects-${crypto.randomUUID()}`,a=await openRecallRepository(name),b=await openRecallRepository(name);
 try{const note=await a.saveNote({body:"メモ",spaceIds:[]}),sketch=await a.saveSketch({title:"描画",strokes:[],spaceIds:[]}),image=await a.saveResource(resource());await a.saveLabels(note.id,["手動タグ"]);const p=await a.saveProject(project());
  for(const id of [note.id,sketch.id,image.id])await b.setItemProjects(id,[p.id]);const data=await a.snapshot();assert.deepEqual(new Set(data.projects[0].itemIds),new Set([note.id,sketch.id,image.id]));
  await a.setItemProjects(note.id,[]);const current=(await b.snapshot()).projects[0];assert.equal(current.itemIds.includes(note.id),false);await b.saveProject({...current,deletedAt:new Date().toISOString()},current.localRevision);
  const kept=await a.snapshot();assert.ok(kept.projects[0].deletedAt);assert.equal(kept.notes.length,1);assert.equal(kept.sketches.length,1);assert.equal(kept.resources.length,1);assert.deepEqual(kept.labels[0].tags,["手動タグ"]);
 }finally{a.close();b.close();}
});
test("space deletion: only memberships disappear across originals and every draft; sharing stays bound to the missing ID",async()=>{
 const repo=await openRecallRepository(`lifecycle-space-${crypto.randomUUID()}`);try{
  const sharing=await repo.prepareAtlasRequestSharing(),id=sharing.spaceId,note=await repo.saveNote({body:"残すメモ",spaceIds:[id,"daily"]}),sketch=await repo.saveSketch({title:"残す線",strokes:[],spaceIds:[id,"creative"]}),r=await repo.saveResource(resource([id,"research"]));
  await repo.saveLabels(note.id,["タグ"]);const p=await repo.saveProject(project([note.id,sketch.id,r.id]));await repo.saveDraft("入力中",[id,"daily"]);await repo.saveRecallEditDraft({noteId:note.id,body:"編集中",spaceIds:[id,"daily"],revision:note.localRevision});await repo.saveSketchDraft({title:"描きかけ",strokes:[],spaceIds:[id,"creative"]});await repo.saveCollectDraft({...resource([id,"research"]),editingId:r.id,expectedRevision:r.localRevision});
  await repo.deleteSpace(id);const data=await repo.snapshot();assert.equal(data.spaces.some(s=>s.id===id),false);assert.deepEqual(data.notes[0].spaceIds,["daily"]);assert.deepEqual(data.sketches[0].spaceIds,["creative"]);assert.deepEqual(data.resources[0].spaceIds,["research"]);assert.deepEqual(data.projects[0].itemIds,p.itemIds);assert.deepEqual(data.labels[0].tags,["タグ"]);
  assert.deepEqual((await repo.loadDraft()).spaceIds,["daily"]);assert.deepEqual((await repo.loadRecallEditDraft())?.spaceIds,["daily"]);assert.deepEqual((await repo.loadSketchDraft()).spaceIds,["creative"]);assert.deepEqual((await repo.loadCollectDraft()).spaceIds,["research"]);
  const replacement=await repo.createSpace("Atlas要望");assert.notEqual(replacement.id,id);assert.equal((await repo.loadAtlasRequestSharing())?.spaceId,id);await assert.rejects(repo.exportAtlasRequests(),/スペース/);
  const current=data.notes[0];const edited=await repo.saveNote({...current,spaceIds:[id,"daily"],body:"別タブの古い所属を含む入力"},current.localRevision);assert.deepEqual(edited.spaceIds,["daily"]);await repo.saveDraft("古い下書き",[id,"research"]);assert.deepEqual((await repo.loadDraft()).spaceIds,["research"]);
 }finally{repo.close();}
});
test("space deletion never mutates an immutable pending operation's payload",async()=>{
 const repo=await openAccountRecallRepository("11111111-1111-4111-8111-111111111111",{name:`lifecycle-immutable-${crypto.randomUUID()}`});try{const n=await repo.saveNote({body:"未送信の版",spaceIds:["daily"]}),before=(await repo.pendingOperations()).find(o=>o.entityId===n.id)!;await repo.deleteSpace("daily");const after=(await repo.pendingOperations()).find(o=>o.id===before.id)!;assert.deepEqual(after,before);assert.deepEqual((await repo.snapshot()).notes[0].spaceIds,[]);}finally{repo.close();}
});
test("permanent tombstones prevent an offline client from reviving a purged original or deleted space",async()=>{
 const owner="11111111-1111-4111-8111-111111111111",repo=await openAccountRecallRepository(owner,{name:`lifecycle-purge-${crypto.randomUUID()}`});try{const n=await repo.saveNote({body:"期限後に戻さない",spaceIds:["daily"]});const remote={...n,serverRevision:1};await repo.acceptPull({cursor:"2",hasMore:false,changes:[],purges:[{entity:"note",id:n.id,ownerId:owner,serverRevision:2,purgedAt:new Date().toISOString()},{entity:"space",id:"daily",ownerId:owner,serverRevision:2,purgedAt:new Date().toISOString()}]});
  await repo.acceptPull({cursor:"3",hasMore:false,changes:[{cursor:"3",entity:"note",record:{...remote,serverRevision:99}}]});assert.equal((await repo.snapshot()).notes.length,0);assert.equal((await repo.pendingOperations()).some(o=>o.entityId===n.id),false);await assert.rejects(repo.saveNote({...n,deletedAt:null},n.localRevision),/削除期限/);
  const fresh=await repo.saveNote({body:"別IDの新規メモ",spaceIds:["daily"]});assert.deepEqual(fresh.spaceIds,[]);
 }finally{repo.close();}
});
test("trash expiry removes original, history references and editing drafts, while a shared image survives",async()=>{
 const repo=await openRecallRepository(`lifecycle-expiry-${crypto.randomUUID()}`),realNow=Date.now;try{
  const blob=new Blob([PNG],{type:"image/png"}),base={...resource(),resourceType:"image" as const,url:"",file:blob};const first=await repo.saveResource(base),other=await repo.saveResource(base);await repo.saveLabels(first.id,["消すタグ"]);const n=await repo.saveNote({body:"残るメモ",spaceIds:[]});await repo.saveRelation({fromItemId:first.id,toItemId:n.id,type:"related_to"});await repo.saveProject(project([first.id,n.id]));await repo.saveCollectDraft({...first,url:first.url??"",sourceUrl:first.sourceUrl??"",editingId:first.id,expectedRevision:first.localRevision},blob);
  const trashed=await repo.updateResource(first.id,{deletedAt:"2026-10-31T00:30:00+09:00"},first.localRevision),deadline=Date.parse(trashPurgeAt(trashed.deletedAt!));Date.now=()=>deadline-1;assert.equal(await repo.purgeExpired(true),0);Date.now=()=>deadline;assert.equal(await repo.purgeExpired(true),1);
  const data=await repo.snapshot();assert.deepEqual(data.resources.map(r=>r.id),[other.id]);assert.equal(data.labels.length,0);assert.equal(data.relations.length,0);assert.deepEqual(data.projects[0].itemIds,[n.id]);assert.equal((await repo.loadCollectDraft()).editingId,undefined);assert.ok(await repo.getResourceFile(other.id));await assert.rejects(repo.updateResource(first.id,{deletedAt:null},trashed.localRevision));
 }finally{Date.now=realNow;repo.close();}
});
