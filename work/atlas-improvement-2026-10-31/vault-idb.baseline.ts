import {assertVault,decryptVault,encryptVault,requireVault,vaultCommitment,type CipherBox,type VaultSession} from "./vault.ts";
type Envelope={id:IDBValidKey;vault:string;sealed:CipherBox};
const context=(db:string,store:string,id:IDBValidKey)=>`idb:${JSON.stringify([db,store,id])}`;
const storageKey=async(db:string,store:string,id:IDBValidKey,vault:VaultSession)=>"k1_"+(await vaultCommitment(id,`idb-key:${JSON.stringify([db,store])}`,vault)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
/** Keep the native transaction alive during WebCrypto, preserving native cross-tab
 * serialization, rollback, quota errors and commit-before-success semantics. */
export function encryptedTransaction(db:IDBDatabase,stores:string[],mode:IDBTransactionMode,current=requireVault()):IDBTransaction{
 assertVault(current);const raw=db.transaction(stores,mode,{durability:"strict"});
 let pending=0,failed=false,failure:unknown=null;let tail=Promise.resolve();
 const ping=()=>{if(failed||pending===0)return;try{const r=raw.objectStore(stores[0]).count();r.onsuccess=ping;r.onerror=()=>{};}catch{}};
 const enqueue=(work:()=>Promise<unknown>)=>{
  assertVault(current);pending++;
  const request={result:undefined,error:null,onsuccess:null,onerror:null} as unknown as IDBRequest;
  tail=tail.then(async()=>{if(failed)throw failure;assertVault(current);const result=await work();assertVault(current);Object.defineProperty(request,"result",{value:result,configurable:true});request.onsuccess?.call(request,new Event("success"));}).catch(error=>{if(!failed){failed=true;failure=error;try{raw.abort();}catch{}}Object.defineProperty(request,"error",{value:failure,configurable:true});request.onerror?.call(request,new Event("error"));}).finally(()=>{pending--;});
  if(pending===1)ping();return request;
 };
 const native=<T>(r:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 const decrypt=async(store:string,value:Envelope|undefined)=>{if(value===undefined)return undefined;if(value.vault!==current.descriptor.id||!value.sealed)throw new Error("未暗号化または別の金庫のデータを拒否しました。");return decryptVault(value.sealed,context(db.name,store,value.id),current);};
 return new Proxy(raw,{get(target,key){
  if(key==="error")return failure??raw.error;
  if(key==="objectStore")return (name:string)=>new Proxy(raw.objectStore(name),{get(store,method){
   if(method==="get")return (id:IDBValidKey)=>enqueue(async()=>decrypt(name,await native(store.get(await storageKey(db.name,name,id,current)))));
   if(method==="getAll")return ()=>enqueue(async()=>Promise.all((await native(store.getAll()) as Envelope[]).map(v=>decrypt(name,v))));
   if(method==="getAllKeys")return ()=>enqueue(async()=>Promise.all((await native(store.getAll()) as Envelope[]).map(async value=>(await decrypt(name,value) as {id:IDBValidKey}).id)));
   if(method==="put"||method==="add")return (value:{id:IDBValidKey})=>{const snapshot=structuredClone(value);return enqueue(async()=>{const id=await storageKey(db.name,name,snapshot.id,current);return native(store[method]({id,vault:current.descriptor.id,sealed:await encryptVault(snapshot,context(db.name,name,id),current)}));});};
   if(method==="delete")return (id:IDBValidKey)=>enqueue(async()=>native(store.delete(await storageKey(db.name,name,id,current))));
   if(["count","clear"].includes(String(method)))return (...args:unknown[])=>enqueue(()=>native((store[method as keyof IDBObjectStore] as Function).apply(store,args)));
   const value=Reflect.get(store,method,store);return typeof value==="function"?value.bind(store):value;
  }});
  const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;
 },set(target,key,value){return Reflect.set(target,key,value,target);}});
}
export async function migrateEncryptedDatabase(db:IDBDatabase,stores:string[],current:VaultSession){
 // Scan and rewrite atomically. Native version 6 closes older application tabs.
 const raw=db.transaction(stores,"readwrite",{durability:"strict"});let active=true;
 const ping=()=>{if(!active)return;const r=raw.objectStore(stores[0]).count();r.onsuccess=ping;};ping();
 const done=new Promise<void>((resolve,reject)=>{raw.oncomplete=()=>resolve();raw.onabort=raw.onerror=()=>reject(raw.error??new Error("暗号化の移行を中断しました。元のデータは保持されています。"));});void done.catch(()=>{});
 const read=(r:IDBRequest<any>)=>new Promise<any>((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 let verified=false;
 try{for(const name of stores){const store=raw.objectStore(name);for(const value of await read(store.getAll())){assertVault(current);if(value.sealed){if(value.vault!==current.descriptor.id)throw new Error("別の金庫のデータです。");if(String(value.id).startsWith("k1_")){if(!verified){await decryptVault(value.sealed,context(db.name,name,value.id),current);verified=true;}continue;}}
  const plain=value.sealed?await decryptVault<{id:IDBValidKey}>(value.sealed,context(db.name,name,value.id),current):value;
  const id=await storageKey(db.name,name,plain.id,current),sealed=await encryptVault(plain,context(db.name,name,id),current);await read(store.put({id,vault:current.descriptor.id,sealed}));if(id!==value.id)await read(store.delete(value.id));
 }}active=false;await done;}catch(e){active=false;try{raw.abort();}catch{}await done.catch(()=>{});throw e;}
}
