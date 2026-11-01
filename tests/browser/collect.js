import {createVault,lockVault,unlockVault,readVaultDescriptor,saveVaultDescriptor} from "/packages/api-client/src/vault.ts";
import {openRecallRepository,openAccountRecallRepository} from "/packages/api-client/src/repository.ts";
import {prepareResourceImage} from "/packages/api-client/src/resource-files.ts";

const results = [], list = document.querySelector("#results");
const passphrase = "browser-verification-fixture-only-2026";
const png = () => new Blob([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="), c => c.charCodeAt(0))], {type:"image/png"});
const blank = () => ({resourceType:"link",url:"",sourceUrl:"",title:"",memo:"",spaceIds:[],inbox:true,image:null});
function assert(condition, message) { if (!condition) throw new Error(message); }
async function check(name, work) {
  const row = document.createElement("li"); row.textContent = `${name}: 実行中`; list.append(row);
  try { await work(); results.push({name,pass:true}); row.textContent = `${name}: 成功`; row.className = "pass"; }
  catch(error) { results.push({name,pass:false,error:String(error),stack:error.stack}); row.textContent = `${name}: ${error}`; row.className = "fail"; }
}
const previous=await readVaultDescriptor();
const created=previous?{descriptor:previous}:await createVault(passphrase);
if(previous)await unlockVault(previous,passphrase);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function rejects(work,pattern){try{await work();}catch(error){assert(pattern.test(String(error)),String(error));return;}throw new Error("Expected rejection");}
async function rawCounts(name,stores){
 const db=await new Promise((resolve,reject)=>{const request=indexedDB.open(name);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
 try{return await new Promise((resolve,reject)=>{const values={},tx=db.transaction(stores);for(const store of stores){const r=tx.objectStore(store).count();r.onsuccess=()=>values[store]=r.result;}tx.oncomplete=()=>resolve(values);tx.onabort=()=>reject(tx.error);});}finally{db.close();}
}
async function delayedEncryption(work){
 const original=crypto.subtle.encrypt;
 crypto.subtle.encrypt=async function(...args){await delay(35);return original.apply(this,args);};
 try{await work();}finally{crypto.subtle.encrypt=original;}
}
await check("画像の下書き保存・投稿・原本の再読込", async () => {
  const name = `collect-browser-${crypto.randomUUID()}`;
  let repo = await openRecallRepository(name);
  try {
    const file=png(), image=await prepareResourceImage(file,"fixture.png"), draft={...blank(),resourceType:"image",image,memo:"画像メモ"};
    await repo.saveCollectDraft(draft,file);
    assert((await repo.getCollectDraftFile())?.size === file.size,"Draft original missing");
    const saved=await repo.saveResource({...draft,file});
    repo.close();repo=await openRecallRepository(name);
    assert((await repo.snapshot()).resources.length===1,"Saved resource missing");
    assert((await repo.getResourceFile(saved.id))?.size===file.size,"Saved original missing");
  } finally {repo.close();}
});
await check("暗号処理とBlob読込の遅延・連続下書き保存",async()=>{
 const repo=await openRecallRepository(`collect-browser-delay-${crypto.randomUUID()}`);
 const read=Blob.prototype.arrayBuffer;
 try{
  const file=png(),image=await prepareResourceImage(file,"delayed.png");
  Blob.prototype.arrayBuffer=async function(){await delay(20);return read.call(this);};
  await delayedEncryption(async()=>{
   await Promise.all(Array.from({length:6},(_,i)=>repo.saveCollectDraft({...blank(),resourceType:"image",image,memo:`下書き${i}`},file)));
   const draft=await repo.loadCollectDraft();assert(draft.memo.startsWith("下書き"),"Missing draft");
   const restored=await repo.getCollectDraftFile();assert(restored?.size===file.size,"Missing delayed original");
   assert((await prepareResourceImage(restored)).sha256===image.sha256,"Original changed");
  });
 }finally{Blob.prototype.arrayBuffer=read;repo.close();}
});
await check("同時編集はrevision比較で1件だけ確定",async()=>{
 const name=`collect-browser-cas-${crypto.randomUUID()}`,a=await openRecallRepository(name),b=await openRecallRepository(name);
 try{
  const saved=await a.saveResource({...blank(),url:"https://example.test/",title:"競合テスト"});
  await delayedEncryption(async()=>{
   const results=await Promise.allSettled([a.updateResource(saved.id,{memo:"画面A"},1),b.updateResource(saved.id,{memo:"画面B"},1)]);
   assert(results.filter(r=>r.status==="fulfilled").length===1,"Concurrent overwrite accepted");
   assert(results.some(r=>r.status==="rejected"&&/別の画面/.test(String(r.reason))),"Missing revision conflict");
  });
  assert((await a.snapshot()).resources[0].localRevision===2,"Incorrect revision");
 }finally{a.close();b.close();}
});
await check("容量不足で原本・記録・下書き・同期待ちが一括で戻る",async()=>{
 const name=`collect-browser-quota-${crypto.randomUUID()}`,repo=await openAccountRecallRepository(crypto.randomUUID(),{name});
 const add=IDBObjectStore.prototype.add;
 try{
  await repo.saveCollectDraft({...blank(),title:"保持する下書き"});
  const before=await rawCounts(name,["resourceFiles","resources","drafts","syncOutbox"]);
  const file=png(),image=await prepareResourceImage(file);
  IDBObjectStore.prototype.add=function(...args){if(this.name==="syncOutbox")throw new DOMException("Injected full storage","QuotaExceededError");return add.apply(this,args);};
  await rejects(()=>repo.saveResource({...blank(),resourceType:"image",image,file}),/QuotaExceeded/);
  IDBObjectStore.prototype.add=add;
  assert(JSON.stringify(await rawCounts(name,Object.keys(before)))===JSON.stringify(before),"Partial write after quota failure");
  assert((await repo.loadCollectDraft()).title==="保持する下書き","Draft lost after failure");
 }finally{IDBObjectStore.prototype.add=add;repo.close();}
});
await check("保存途中のロックは未確定の原本と記録を残さない",async()=>{
 const name=`collect-browser-lock-${crypto.randomUUID()}`,repo=await openRecallRepository(name);
 const encrypt=crypto.subtle.encrypt;
 let started;const reached=new Promise(resolve=>started=resolve);
 try{
  await repo.saveCollectDraft({...blank(),memo:"ロック前の下書き"});
  const before=await rawCounts(name,["resourceFiles","resources","drafts"]),file=png(),image=await prepareResourceImage(file);
  crypto.subtle.encrypt=async function(...args){started();await delay(100);return encrypt.apply(this,args);};
  const saving=repo.saveResource({...blank(),resourceType:"image",image,file});
  // Attach a rejection handler before locking, including transaction-abort events.
  const rejected=rejects(()=>saving,/ロック/);
  await reached;lockVault();await rejected;
  assert(JSON.stringify(await rawCounts(name,Object.keys(before)))===JSON.stringify(before),"Partial write after lock");
 }finally{crypto.subtle.encrypt=encrypt;repo.close();await unlockVault(created.descriptor,passphrase);}
 const reopened=await openRecallRepository(name);
 try{assert((await reopened.loadCollectDraft()).memo==="ロック前の下書き","Committed draft lost");}finally{reopened.close();}
});
await check("非同期のIndexedDBエラーでも全体を取り消す",async()=>{
 const name=`collect-browser-async-error-${crypto.randomUUID()}`,repo=await openAccountRecallRepository(crypto.randomUUID(),{name});
 const add=IDBObjectStore.prototype.add;
 try{
  await repo.saveCollectDraft({...blank(),title:"非同期エラー前"});
  const before=await rawCounts(name,["resourceFiles","resources","drafts","syncOutbox"]),file=png(),image=await prepareResourceImage(file);
  IDBObjectStore.prototype.add=function(...args){if(this.name==="syncOutbox")add.apply(this,args);return add.apply(this,args);};
  await rejects(()=>repo.saveResource({...blank(),resourceType:"image",image,file}),/ConstraintError/);
  IDBObjectStore.prototype.add=add;
  assert(JSON.stringify(await rawCounts(name,Object.keys(before)))===JSON.stringify(before),"Partial write after native request error");
 }finally{IDBObjectStore.prototype.add=add;repo.close();}
});
await check("旧形式の画像下書きは遅延暗号処理でも一括移行",async()=>{
 const name=`collect-browser-migration-${crypto.randomUUID()}`,file=png(),image=await prepareResourceImage(file);
 const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(name,5);r.onupgradeneeded=()=>{r.result.createObjectStore("drafts",{keyPath:"id"});r.result.createObjectStore("resourceFiles",{keyPath:"id"});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 await new Promise((resolve,reject)=>{const tx=db.transaction(["drafts","resourceFiles"],"readwrite");tx.objectStore("drafts").put({id:"collect-composer",...blank(),resourceType:"image",image,memo:"旧下書き"});tx.objectStore("resourceFiles").put({id:image.sha256,blob:file});tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
 await delayedEncryption(async()=>{
  const repo=await openRecallRepository(name);
  try{assert((await repo.loadCollectDraft()).memo==="旧下書き","Migration lost draft");assert((await repo.getCollectDraftFile())?.size===file.size,"Migration lost original");}finally{repo.close();}
 });
});
await saveVaultDescriptor(created.descriptor);
const fixtureRepo=await openRecallRepository();
try{
 const note=await fixtureRepo.saveNote({body:"関連リンクの検証用メモ",spaceIds:[]});
 const sketch=await fixtureRepo.saveSketch({title:"関連リンクの検証用スケッチ",strokes:[],spaceIds:[]});
 await fixtureRepo.saveRelation({fromItemId:sketch.id,toItemId:note.id,type:"inspired_by"});
}finally{fixtureRepo.close();}
await fetch("/__verify/results",{method:"POST",body:JSON.stringify({userAgent:navigator.userAgent,results})});
