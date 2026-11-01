import {assertVault,decryptVault,encryptVault,requireVault,vaultCommitment,type CipherBox,type VaultSession} from "./vault.ts";
type Envelope={id:IDBValidKey;vault:string;sealed:CipherBox};
const context=(db:string,store:string,id:IDBValidKey)=>`idb:${JSON.stringify([db,store,id])}`;
const storageKey=async(db:string,store:string,id:IDBValidKey,vault:VaultSession)=>"k1_"+(await vaultCommitment(id,`idb-key:${JSON.stringify([db,store])}`,vault)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");

/** Keeping a transaction live does not make WebCrypto/Blob continuations active.
 * Issue every native request synchronously inside a native request callback.
 * https://www.w3.org/TR/IndexedDB/#transaction-lifecycle */
function activeRequests(tx:IDBTransaction,store:string,busy:()=>boolean,check:()=>void,fail:(error:unknown)=>void){
 type Waiting={start:()=>void;reject:(error:unknown)=>void};
 const waiting:Waiting[]=[];
 let ticking=false,ended=false;
 tx.addEventListener("abort",()=>{
  ended=true;
  for(const job of waiting.splice(0))job.reject(tx.error??new DOMException("保存を中断しました。","AbortError"));
 });
 tx.addEventListener("complete",()=>{ended=true;});
 function tick(){
  if(ticking||ended)return;
  try{
   check();ticking=true;
   const pulse=tx.objectStore(store).count();
   pulse.onsuccess=()=>{
    ticking=false;
    try{
     check();
     for(const job of waiting.splice(0))job.start();
     if(busy()||waiting.length)tick();
    }catch(error){fail(error);}
   };
   pulse.onerror=event=>{event.preventDefault();fail(pulse.error);};
  }catch(error){ticking=false;fail(error);}
 }
 function run<T>(work:()=>IDBRequest<T>):Promise<T>{
  return new Promise((resolve,reject)=>{
   if(ended){reject(new DOMException("保存を中断しました。","AbortError"));return;}
   waiting.push({reject,start(){
    try{
     check();const request=work();
     request.onsuccess=()=>resolve(request.result);
     request.onerror=event=>{event.preventDefault();fail(request.error);reject(request.error);};
    }catch(error){fail(error);reject(error);}
   }});
   tick();
  });
 }
 return {run,start:tick};
}

/** Preserve native cross-tab serialization, revision checks, rollback and
 * commit-before-success while encrypted operations wait for Blob/WebCrypto. */
export function encryptedTransaction(db:IDBDatabase,stores:string[],mode:IDBTransactionMode,current=requireVault()):IDBTransaction{
 assertVault(current);const raw=db.transaction(stores,mode,{durability:"strict"});
 let pending=0,failed=false,failure:unknown=null,tail=Promise.resolve();
 const fail=(error:unknown)=>{if(failed)return;failed=true;failure=error;try{raw.abort();}catch{}};
 const native=activeRequests(raw,stores[0],()=>pending>0,()=>{if(failed)throw failure;assertVault(current);},fail);
 const enqueue=(work:()=>Promise<unknown>)=>{
  assertVault(current);pending++;
  const request={result:undefined,error:null,onsuccess:null,onerror:null} as unknown as IDBRequest;
  tail=tail.then(async()=>{
   if(failed)throw failure;assertVault(current);
   const result=await work();assertVault(current);
   Object.defineProperty(request,"result",{value:result,configurable:true});
   request.onsuccess?.call(request,new Event("success"));
  }).catch(error=>{
   fail(error);
   Object.defineProperty(request,"error",{value:failure,configurable:true});
   request.onerror?.call(request,new Event("error"));
  }).finally(()=>{pending--;});
  native.start();return request;
 };
 const decrypt=async(store:string,value:Envelope|undefined)=>{if(value===undefined)return undefined;if(value.vault!==current.descriptor.id||!value.sealed)throw new Error("未暗号化または別の金庫のデータを拒否しました。");return decryptVault(value.sealed,context(db.name,store,value.id),current);};
 return new Proxy(raw,{get(target,key){
  if(key==="error")return failure??raw.error;
  if(key==="objectStore")return (name:string)=>new Proxy(raw.objectStore(name),{get(store,method){
   if(method==="get")return (id:IDBValidKey)=>enqueue(async()=>{const key=await storageKey(db.name,name,id,current);return decrypt(name,await native.run(()=>store.get(key)));});
   if(method==="getAll")return ()=>enqueue(async()=>Promise.all((await native.run(()=>store.getAll()) as Envelope[]).map(v=>decrypt(name,v))));
   if(method==="getAllKeys")return ()=>enqueue(async()=>Promise.all((await native.run(()=>store.getAll()) as Envelope[]).map(async value=>(await decrypt(name,value) as {id:IDBValidKey}).id)));
   if(method==="put"||method==="add")return (value:{id:IDBValidKey})=>{const snapshot=structuredClone(value);return enqueue(async()=>{
    const id=await storageKey(db.name,name,snapshot.id,current),sealed=await encryptVault(snapshot,context(db.name,name,id),current);
    return native.run(()=>store[method]({id,vault:current.descriptor.id,sealed}));
   });};
   if(method==="delete")return (id:IDBValidKey)=>enqueue(async()=>{const key=await storageKey(db.name,name,id,current);return native.run(()=>store.delete(key));});
   if(method==="count")return ()=>enqueue(()=>native.run(()=>store.count()));
   if(method==="clear")return ()=>enqueue(()=>native.run(()=>store.clear()));
   const value=Reflect.get(store,method,store);return typeof value==="function"?value.bind(store):value;
  }});
  const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;
 },set(target,key,value){return Reflect.set(target,key,value,target);}});
}
export async function migrateEncryptedDatabase(db:IDBDatabase,stores:string[],current:VaultSession){
 // Scan and rewrite atomically. Native version 6 closes older application tabs.
 const raw=db.transaction(stores,"readwrite",{durability:"strict"});let active=true,failure:unknown=null;
 const done=new Promise<void>((resolve,reject)=>{raw.oncomplete=()=>resolve();raw.onabort=raw.onerror=()=>reject(failure??raw.error??new Error("暗号化の移行を中断しました。元のデータは保持されています。"));});void done.catch(()=>{});
 const native=activeRequests(raw,stores[0],()=>active,()=>assertVault(current),error=>{failure=error;try{raw.abort();}catch{}});
 native.start();let verified=false;
 try{
  for(const name of stores){
   const store=raw.objectStore(name);
   for(const value of await native.run(()=>store.getAll())){
    assertVault(current);
    if(value.sealed){
     if(value.vault!==current.descriptor.id)throw new Error("別の金庫のデータです。");
     if(String(value.id).startsWith("k1_")){if(!verified){await decryptVault(value.sealed,context(db.name,name,value.id),current);verified=true;}continue;}
    }
    const plain=value.sealed?await decryptVault<{id:IDBValidKey}>(value.sealed,context(db.name,name,value.id),current):value;
    const id=await storageKey(db.name,name,plain.id,current),sealed=await encryptVault(plain,context(db.name,name,id),current);
    await native.run(()=>store.put({id,vault:current.descriptor.id,sealed}));
    if(id!==value.id)await native.run(()=>store.delete(value.id));
   }
  }
  active=false;await done;
 }catch(error){active=false;try{raw.abort();}catch{}await done.catch(()=>{});throw error;}
}
