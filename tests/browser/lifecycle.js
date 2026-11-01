import {createVault,unlockVault,readVaultDescriptor,saveVaultDescriptor} from "/packages/api-client/src/vault.ts";
import {openRecallRepository,openAccountRecallRepository} from "/packages/api-client/src/repository.ts";
import {prepareResourceImage} from "/packages/api-client/src/resource-files.ts";
const phrase="browser-verification-fixture-only-2026",descriptor=await readVaultDescriptor();
if(descriptor)await unlockVault(descriptor,phrase);else{const created=await createVault(phrase);await saveVaultDescriptor(created.descriptor);}
const results=[],assert=(value,message)=>{if(!value)throw new Error(message);};
const png=()=>new Blob([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="),c=>c.charCodeAt(0))],{type:"image/png"});
try{
 const repo=await openRecallRepository(`native-lifecycle-${crypto.randomUUID()}`);
 try{
  const space=await repo.createSpace("消す場所","#3b82f6"),other=await repo.createSpace("残す場所","#3b82f6"),ids=[space.id,other.id];
  const note=await repo.saveNote({body:"原本",spaceIds:ids}),sketch=await repo.saveSketch({title:"描画",strokes:[],spaceIds:ids}),file=png(),image=await prepareResourceImage(file,"original.png"),resource=await repo.saveResource({url:"",sourceUrl:"",resourceType:"image",title:"画像",memo:"",spaceIds:ids,inbox:true,image,file});
  const project=await repo.saveProject({name:"共有プロジェクト",description:"",status:"active",dueDate:null,itemIds:[note.id,sketch.id,resource.id]});await repo.saveLabels(note.id,["手動タグ"]);
  await repo.saveDraft("入力中",ids);await repo.saveRecallEditDraft({noteId:note.id,body:"編集中",spaceIds:ids,revision:note.localRevision});await repo.saveSketchDraft({title:"描画中",strokes:[],spaceIds:ids});await repo.saveCollectDraft({resourceType:"image",url:"",sourceUrl:"",title:"下書き",memo:"画像下書き",spaceIds:ids,inbox:true,image},file);
  const encrypt=crypto.subtle.encrypt;crypto.subtle.encrypt=async function(...args){await new Promise(r=>setTimeout(r,15));return encrypt.apply(this,args);};
  try{await repo.deleteSpace(space.id);}finally{crypto.subtle.encrypt=encrypt;}
  const snap=await repo.snapshot();assert(snap.notes.length===1&&snap.sketches.length===1&&snap.resources.length===1,"Originals lost");
  for(const item of [...snap.notes,...snap.sketches,...snap.resources])assert(JSON.stringify(item.spaceIds)===JSON.stringify([other.id]),"Membership not removed");
  for(const draft of [await repo.loadDraft(),await repo.loadRecallEditDraft(),await repo.loadSketchDraft(),await repo.loadCollectDraft()])assert(JSON.stringify(draft.spaceIds)===JSON.stringify([other.id]),"Draft membership not removed");
  assert(snap.projects.find(p=>p.id===project.id).itemIds.length===3&&snap.labels[0].tags[0]==="手動タグ","Project/tag changed");assert((await repo.getResourceFile(resource.id)).size===file.size,"Original file lost");results.push("実IndexedDBと遅い暗号処理で、原本・プロジェクト・タグ・全下書きを保持してスペースだけ削除");
  const expired=await repo.saveNote({body:"期限後",spaceIds:[],deletedAt:"2020-01-31T12:00:00.000Z"});await repo.purgeExpired(true);assert(!(await repo.snapshot()).notes.some(n=>n.id===expired.id),"Expired record survived");let rejected=false;try{await repo.saveNote({...expired,deletedAt:null},expired.localRevision);}catch{rejected=true;}assert(rejected,"Expired restore accepted");results.push("端末内の期限切れ記録を完全削除し、古い編集からの復元を拒否");
 }finally{repo.close();}
 const owner=crypto.randomUUID(),account=await openAccountRecallRepository(owner,{name:`native-retained-file-${crypto.randomUUID()}`});try{
  const file=png(),image=await prepareResourceImage(file,"offline.png"),resource=await account.saveResource({url:"",sourceUrl:"",resourceType:"image",title:"オフライン原本",memo:"",spaceIds:[],inbox:true,image,file}),op=(await account.pendingOperations()).find(op=>op.entityId===resource.id),canonical={...resource,serverRevision:1};await account.acceptPush(op,{status:"applied",operationId:op.id,record:canonical});
  const current=(await account.snapshot()).resources[0];await account.updateResource(resource.id,{deletedAt:"2020-01-01T00:00:00.000Z"},current.localRevision);await account.purgeExpired(true);assert(await account.getResourceFile(resource.id)===null,"Expired image remained accessible");
  await account.acceptPull({changes:[{entity:"resource",cursor:"1",record:canonical}],cursor:"1",hasMore:false});assert((await account.getResourceFile(resource.id))?.size===file.size,"Remote restore lost the offline original");results.push("実IndexedDBでオフライン中の期限切れ画像を非表示にし、別端末の復元後に原本を保持");
 }finally{account.close();}
 const repo2=await openRecallRepository();try{
  const space=await repo2.createSpace("Atlas要望","#3b82f6"),other=await repo2.createSpace("Dで残す","#3b82f6"),ids=[space.id,other.id],note=await repo2.saveNote({body:"Dの共通メモ",spaceIds:ids}),sketch=await repo2.saveSketch({title:"Dの共通スケッチ",strokes:[],spaceIds:ids}),file=png(),image=await prepareResourceImage(file,"d.png"),resource=await repo2.saveResource({url:"",sourceUrl:"",resourceType:"image",title:"Dの共通画像",memo:"Dの画像原本",spaceIds:ids,inbox:true,image,file});
  const project=await repo2.saveProject({name:"D共有プロジェクト",description:"既存Atlasの行を使う",status:"active",dueDate:null,itemIds:[note.id,sketch.id,resource.id]});await repo2.saveLabels(note.id,["D手動タグ"]);await repo2.prepareAtlasRequestSharing(space.id);
  window.fixture={space:space.id,other:other.id,note:note.id,sketch:sketch.id,resource:resource.id,project:project.id};
 }finally{repo2.close();}
 window.lifecycleResults={pass:true,results};
}catch(error){window.lifecycleResults={pass:false,results,error:String(error),stack:error.stack};}
document.querySelector("#results").textContent=JSON.stringify(window.lifecycleResults,null,2);
