import {trashIsExpired,validatePurgeNotice,type PurgeNotice,type SyncRecord,type Space,type AtlasProject,type AtlasItem,type ItemRelation,type SyncConflict} from "@personal-tools/core";
type Context={ownerId:string|null;transaction:()=>IDBTransaction;queue:(tx:IDBTransaction,record:SyncRecord)=>Promise<void>;emit:()=>void};
const stores={note:"notes",space:"spaces",sketch:"sketches",resource:"resources",relation:"relations",project:"projects",labels:"labels"};
const originalHash=(value:any):string|undefined=>value?.original?.sha256??value?.image?.sha256;
const key=(entity:string,id:string)=>`purged:${entity}:${id}`;
const get=<T=any>(request:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
async function atomic<T>(tx:IDBTransaction,work:()=>Promise<T>):Promise<T>{const done=new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error??new Error("保存できませんでした。"));});void done.catch(()=>{});try{const result=await work();await done;return result;}catch(error){try{tx.abort();}catch{}await done.catch(()=>{});throw error;}}
export function createRepositoryLifecycle(context:Context){
 const {ownerId,transaction,queue,emit}=context;let lastSweep=-Infinity;
 async function notice(tx:IDBTransaction,entity:string,id:string):Promise<PurgeNotice|undefined>{return (await get(tx.objectStore("meta").get(key(entity,id))))?.value;}
 async function notices(tx:IDBTransaction){return (await get<any[]>(tx.objectStore("meta").getAll())).filter(row=>row.id.startsWith("purged:")).map(row=>row.value as PurgeNotice);}
 async function filterSpaceIds(tx:IDBTransaction,ids:string[]){const removed=await Promise.all(ids.map(id=>notice(tx,"space",id)));return ids.filter((_,i)=>!removed[i]);}
 async function assertEditable(tx:IDBTransaction,entity:keyof typeof stores,id:string,current?:SyncRecord){if(!current&&tx.objectStoreNames.contains(stores[entity]))current=await get(tx.objectStore(stores[entity]).get(id));if(await notice(tx,entity,id)||current&&trashIsExpired(current))throw new Error("この記録は削除期限を過ぎたため、復元・変更できません。");}
 async function sanitizeRecord(tx:IDBTransaction,record:SyncRecord):Promise<SyncRecord|null>{
  const entity="kind" in record?record.kind:"space",purged=await notice(tx,entity,record.id);
  if(purged){if(purged.temporary&&(record.serverRevision??0)>=purged.serverRevision&&!trashIsExpired(record))tx.objectStore("meta").delete(key(entity,record.id));else return null;}
  const all=await notices(tx);
  if("spaceIds" in record)return {...record,spaceIds:record.spaceIds.filter(id=>!all.some(p=>p.entity==="space"&&p.id===id))};
  if("kind" in record&&record.kind==="project")return {...record,itemIds:record.itemIds.filter(id=>!all.some(p=>!p.temporary&&["note","sketch","resource"].includes(p.entity)&&p.id===id))};
  if("kind" in record&&record.kind==="relation"&&all.some(p=>!p.temporary&&(p.id===record.fromItemId||p.id===record.toItemId)))return null;
  return record;
 }
 async function applyPurges(tx:IDBTransaction,input:PurgeNotice[]){
  const candidates=new Set<string>();
  const work=[...input],seen=new Set<string>();
  for(const value of work){
   const p=validatePurgeNotice(value,ownerId);if(seen.has(key(p.entity,p.id)))continue;seen.add(key(p.entity,p.id));const old=await notice(tx,p.entity,p.id);if(old&&!old.temporary&&(p.temporary||old.serverRevision>p.serverRevision))continue;
   const retainedKey=`expired-files:${p.entity}:${p.id}`,itemHashes=new Set<string>((await get(tx.objectStore("meta").get(retainedKey)))?.value??[]);
   tx.objectStore("meta").put({id:key(p.entity,p.id),value:p});
   const record=await get(tx.objectStore(stores[p.entity]).get(p.id));if(originalHash(record))itemHashes.add(originalHash(record)!);
   tx.objectStore(stores[p.entity]).delete(p.id);tx.objectStore("outbox").delete(p.id);tx.objectStore("resourceJobs").delete(p.id);const deferred=await get(tx.objectStore("meta").get(`deferred:${p.entity}:${p.id}`));if(originalHash(deferred?.value))itemHashes.add(originalHash(deferred.value)!);tx.objectStore("meta").delete(`deferred:${p.entity}:${p.id}`);
   for(const op of await get<any[]>(tx.objectStore("syncOutbox").getAll()))if(op.entityId===p.id&&op.kind===`put_${p.entity}`){if(originalHash(op.payload))itemHashes.add(originalHash(op.payload)!);tx.objectStore("syncOutbox").delete(op.id);}
   for(const conflict of await get<SyncConflict[]>(tx.objectStore("conflicts").getAll()))if(conflict.entity===p.entity&&conflict.entityId===p.id){if(originalHash(conflict.local))itemHashes.add(originalHash(conflict.local)!);tx.objectStore("conflicts").delete(conflict.id);}
   for(const draft of await get<any[]>(tx.objectStore("drafts").getAll())){
    if(draft.editingId===p.id||draft.value?.noteId===p.id){if(originalHash(draft))itemHashes.add(originalHash(draft)!);tx.objectStore("drafts").delete(draft.id);}
    else if(draft.sourceNoteId===p.id)tx.objectStore("drafts").put({...draft,sourceNoteId:undefined});
   }
   if(p.temporary&&itemHashes.size)tx.objectStore("meta").put({id:retainedKey,value:[...itemHashes]});else tx.objectStore("meta").delete(retainedKey);
   for(const hash of itemHashes)candidates.add(hash);
   if(!p.temporary&&["note","sketch","resource"].includes(p.entity)){
    work.push({...p,entity:"labels"});
    for(const relation of await get<ItemRelation[]>(tx.objectStore("relations").getAll()))if(relation.fromItemId===p.id||relation.toItemId===p.id)work.push({...p,entity:"relation",id:relation.id});
   }
  }
  const all=await notices(tx),spaces=new Set(all.filter(p=>p.entity==="space").map(p=>p.id)),items=new Set(all.filter(p=>!p.temporary&&["note","sketch","resource"].includes(p.entity)).map(p=>p.id));
  for(const store of ["notes","sketches","resources","projects"]){for(const record of await get<SyncRecord[]>(tx.objectStore(store).getAll())){
   const field="spaceIds" in record?"spaceIds":"itemIds" in record?"itemIds":null;if(!field)continue;
   const ids=(record as any)[field] as string[],next=ids.filter(id=>!(field==="spaceIds"?spaces:items).has(id));
   if(next.length!==ids.length){const updated={...record,[field]:next,localRevision:(record.localRevision??0)+1,updatedAt:new Date().toISOString()};tx.objectStore(store).put(updated);await queue(tx,updated);}
  }}
  for(const draft of await get<any[]>(tx.objectStore("drafts").getAll())){const next={...draft};if(Array.isArray(next.spaceIds))next.spaceIds=next.spaceIds.filter((id:string)=>!spaces.has(id));if(next.value?.spaceIds)next.value={...next.value,spaceIds:next.value.spaceIds.filter((id:string)=>!spaces.has(id))};if(JSON.stringify(next)!==JSON.stringify(draft))tx.objectStore("drafts").put(next);}
  // Local originals are shared by SHA-256: retain a Blob while any resource or draft uses it.
  const used=new Set<string>();for(const resource of await get<any[]>(tx.objectStore("resources").getAll()))if(originalHash(resource))used.add(originalHash(resource)!);for(const draft of await get<any[]>(tx.objectStore("drafts").getAll()))if(originalHash(draft))used.add(originalHash(draft)!);
  for(const conflict of await get<SyncConflict[]>(tx.objectStore("conflicts").getAll()))for(const version of [conflict.local,conflict.remote])if(originalHash(version))used.add(originalHash(version)!);
  // An offline cache is not authoritative: retain encrypted bytes until the server confirms deletion.
  for(const row of await get<any[]>(tx.objectStore("meta").getAll()))if(row.id.startsWith("expired-files:"))for(const hash of row.value)used.add(hash);
  for(const hash of candidates)if(!used.has(hash))tx.objectStore("resourceFiles").delete(hash);
 }
 async function purgeExpired(force=false){
  const now=Date.now();if(!force&&now>=lastSweep&&now-lastSweep<30000)return 0;const tx=transaction();
  const count=await atomic(tx,async()=>{const expired:PurgeNotice[]=[];for(const [entity,store] of [["note","notes"],["sketch","sketches"],["resource","resources"]] as const)for(const r of await get<SyncRecord[]>(tx.objectStore(store).getAll()))if(trashIsExpired(r,now))expired.push({entity,id:r.id,ownerId,serverRevision:r.serverRevision??0,purgedAt:new Date(now).toISOString(),...(ownerId?{temporary:true}:{})});if(expired.length)await applyPurges(tx,expired);return expired.length;});lastSweep=now;if(count)emit();return count;
 }
 async function deleteSpace(id:string){const tx=transaction();await atomic(tx,async()=>{const previous=await get<Space|undefined>(tx.objectStore("spaces").get(id));if(!previous)throw new Error("スペースが見つかりません。");const now=new Date().toISOString();await applyPurges(tx,[{entity:"space",id,ownerId,serverRevision:previous.serverRevision??0,purgedAt:now}]);await queue(tx,{...previous,ownerId,deletedAt:now,localRevision:(previous.localRevision??0)+1});});emit();}
 async function setItemProjects(itemId:string,projectIds:string[]){
  const tx=transaction();await atomic(tx,async()=>{const candidates=await Promise.all(["notes","sketches","resources"].map(store=>get<AtlasItem|undefined>(tx.objectStore(store).get(itemId))));const item=candidates.find(v=>v&&v.ownerId===ownerId&&!v.deletedAt);if(!item)throw new Error("所属を変更する記録が見つかりません。");await assertEditable(tx,item.kind,item.id,item);
   const projects=await get<AtlasProject[]>(tx.objectStore("projects").getAll()),selected=new Set(projectIds);if(projectIds.length>1000||projectIds.some(id=>!projects.some(p=>p.id===id&&!p.deletedAt&&p.ownerId===ownerId)))throw new Error("プロジェクトが見つかりません。");
   for(const project of projects.filter(p=>!p.deletedAt&&p.ownerId===ownerId)){const included=project.itemIds.includes(itemId),wanted=selected.has(project.id);if(included===wanted)continue;const updated={...project,itemIds:wanted?[...project.itemIds,itemId]:project.itemIds.filter(id=>id!==itemId),updatedAt:new Date().toISOString(),localRevision:project.localRevision+1};if(updated.itemIds.length>1000)throw new Error("1つのプロジェクトの記録は1,000件までです。");tx.objectStore("projects").put(updated);await queue(tx,updated);}
  });emit();
 }
 return {notice,filterSpaceIds,assertEditable,sanitizeRecord,applyPurges,purgeExpired,deleteSpace,setItemProjects};
}
