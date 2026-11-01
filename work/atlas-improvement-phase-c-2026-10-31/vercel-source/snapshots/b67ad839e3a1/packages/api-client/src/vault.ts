import {argon2id} from "hash-wasm";
import {deviceTokenIsCurrent,loadRememberedVault,revokeRememberedVault,VAULT_REVOCATION_KEY} from "./vault-device.ts";

export type CipherBox={v:1;iv:string;ciphertext:string};
export type VaultDescriptor={version:1;id:string;kdf:{name:"argon2id";memory:65536;iterations:3;parallelism:4;salt:string};password:CipherBox;recovery:CipherBox};
export type VaultSession={descriptor:VaultDescriptor;key:CryptoKey;indexKey:CryptoKey;epoch:number;unlockedAt:number;scope?:string;expiresAt?:number;retentionToken?:string};
let session:VaultSession|null=null,epoch=0;
let pendingShare:string|null=null;
export function captureLegacyVaultShare(){if(typeof window==="undefined"||!window.location.pathname.startsWith("/collect"))return;const url=new URL(window.location.href);if(!["url","text","title"].some(k=>url.searchParams.has(k)))return;pendingShare=url.search;for(const k of ["url","text","title"])url.searchParams.delete(k);window.history.replaceState(null,"",url.pathname+url.search+url.hash);}
export function consumeLegacyVaultShare(){const value=pendingShare;pendingShare=null;return value;}
const subscribers=new Set<()=>void>();
const flushers=new Set<()=>Promise<unknown>>();
const lockObservers=new Set<(busy:boolean)=>void>();
let flushing=0,flushPromise:Promise<void>|null=null,lockPromise:Promise<void>|null=null;
let control:BroadcastChannel|null=null;
const tabId=crypto.randomUUID();
type Peer={done:Promise<void>;resolve:()=>void;reject:(error:unknown)=>void};
let pendingPeers:Map<string,Peer>|null=null,pendingRequest="";
let remoteTimer:ReturnType<typeof setTimeout>|undefined;
const encoder=new TextEncoder(),decoder=new TextDecoder("utf-8",{fatal:true});
export function base64(bytes:Uint8Array):string{let text="";for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(text);}
export function unbase64(value:string):Uint8Array<ArrayBuffer>{const text=atob(value),bytes=new Uint8Array(text.length);for(let i=0;i<text.length;i++)bytes[i]=text.charCodeAt(i);return bytes;}
const random=(size:number)=>crypto.getRandomValues(new Uint8Array(size));
export function vaultSession(){return session;}
export function requireVault():VaultSession{if(!session)throw new Error("金庫を解錠してください。");assertVault(session);return session;}
export function assertVault(current:VaultSession){if(session!==current||!flushing&&current.retentionToken&&!deviceTokenIsCurrent(current.retentionToken))throw new Error("金庫をロックしました。解錠してやり直してください。");if(!flushing&&current.expiresAt&&Date.now()>=current.expiresAt)throw new Error("解錠の期限が切れました。もう一度解錠してください。");}
export function subscribeVault(listener:()=>void){subscribers.add(listener);return()=>{subscribers.delete(listener);};}
/** Page navigation drops only this page's references; manual locks revoke persistence. */
export function clearVaultMemory(){session=null;epoch++;for(const listener of subscribers)listener();}
export function lockVault(){void revokeRememberedVault().catch(()=>{});clearVaultMemory();if(typeof window!=="undefined"&&typeof BroadcastChannel!=="undefined"){const c=new BroadcastChannel("personal-tools-vault-lock");c.postMessage("lock");c.close();}}
export function beforeVaultLock(flush:()=>Promise<unknown>){flushers.add(flush);return()=>{flushers.delete(flush);};}
export function flushVaultDrafts(){
 if(flushPromise)return flushPromise;
 flushPromise=(async()=>{flushing++;try{const results=await Promise.allSettled([...flushers].map(f=>Promise.resolve().then(f)));if(results.some(r=>r.status==="rejected"))throw new Error("直前の下書きを保存できませんでした。画面に入力を残しています。保存してから、もう一度お試しください。");}finally{flushing--;}})().finally(()=>{flushPromise=null;});
 return flushPromise;
}
const lockBusy=(busy:boolean)=>{for(const observer of lockObservers)observer(busy);};
function initializeVaultControl(){
 if(control||typeof window==="undefined"||typeof BroadcastChannel==="undefined")return;
 control=new BroadcastChannel("personal-tools-vault-lock");
 control.onmessage=event=>{
  const message=event.data;
  if(message==="lock"||message?.type==="commit-lock"){clearTimeout(remoteTimer);clearVaultMemory();lockBusy(false);return;}
  if(message?.type==="prepare-lock"&&typeof message.id==="string"){
   control?.postMessage({type:"ready-lock",id:message.id,tab:tabId});lockBusy(true);
   clearTimeout(remoteTimer);remoteTimer=setTimeout(()=>lockBusy(false),8000);
   void flushVaultDrafts().then(()=>control?.postMessage({type:"saved-lock",id:message.id,tab:tabId}),()=>control?.postMessage({type:"failed-lock",id:message.id,tab:tabId}));
  }else if(message?.type==="cancel-lock"){clearTimeout(remoteTimer);lockBusy(false);}
  else if(message?.id===pendingRequest&&typeof message.tab==="string"&&pendingPeers){
   let peer=pendingPeers.get(message.tab);
   if(!peer){let resolve!:()=>void,reject!:(error:unknown)=>void;const done=new Promise<void>((a,b)=>{resolve=a;reject=b;});void done.catch(()=>{});peer={done,resolve,reject};pendingPeers.set(message.tab,peer);}
   if(message.type==="saved-lock")peer.resolve();else if(message.type==="failed-lock")peer.reject(new Error("ほかのタブの下書きを保存できませんでした。入力を確認してから、もう一度ロックしてください。"));
  }
 };
}
export function observeVaultLock(observer:(busy:boolean)=>void){
 initializeVaultControl();lockObservers.add(observer);
 const revoked=(event:StorageEvent)=>{if(event.key===VAULT_REVOCATION_KEY){clearVaultMemory();lockBusy(false);}};
 if(typeof window!=="undefined")window.addEventListener("storage",revoked);
 return()=>{lockObservers.delete(observer);if(typeof window!=="undefined")window.removeEventListener("storage",revoked);if(!lockObservers.size){control?.close();control=null;}};
}
/** Active tabs acknowledge draft commits before persistent and in-memory keys go. */
export function requestVaultLock(options:{force?:boolean}={}){
 if(lockPromise)return lockPromise;
 initializeVaultControl();lockBusy(true);
 lockPromise=(async()=>{
  const id=crypto.randomUUID();pendingRequest=id;pendingPeers=new Map();
  let timeout:ReturnType<typeof setTimeout>|undefined,committed=false;
  try{
   control?.postMessage({type:"prepare-lock",id});
   const own=flushVaultDrafts();void own.catch(()=>{});
   if(control)await new Promise(resolve=>setTimeout(resolve,150));
   await Promise.race([Promise.all([own,...[...pendingPeers.values()].map(peer=>peer.done)]),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error("ほかのタブの保存を確認できませんでした。タブを開いてから、もう一度ロックしてください。")),6000);})]);
   try{await revokeRememberedVault();}finally{committed=true;clearVaultMemory();control?.postMessage({type:"commit-lock",id});}
  }catch(error){
   if(!committed){if(options.force){await revokeRememberedVault().catch(()=>{});clearVaultMemory();control?.postMessage({type:"commit-lock",id});}
   else control?.postMessage({type:"cancel-lock",id});}
   throw error;
  }finally{clearTimeout(timeout);pendingPeers=null;pendingRequest="";lockBusy(false);}
 })().finally(()=>{lockPromise=null;});return lockPromise;
}
export async function resumeVault(descriptor:VaultDescriptor,scope:string){
 const before=epoch,record=await loadRememberedVault(validateDescriptor(descriptor),scope);
 if(!record)return null;
 if(epoch!==before||!deviceTokenIsCurrent(record.token)||Date.now()>=record.expiresAt)throw new Error("金庫の状態が変わりました。もう一度解錠してください。");
 session={descriptor:validateDescriptor(descriptor),key:record.key,indexKey:record.indexKey,epoch:++epoch,unlockedAt:record.issuedAt,scope,expiresAt:record.expiresAt,retentionToken:record.token};
 for(const listener of subscribers)listener();return session;
}
export function validateDescriptor(value:unknown):VaultDescriptor{
 const d=value as VaultDescriptor;
 if(!d||d.version!==1||!/^[-0-9a-f]{36}$/i.test(d.id)||d.kdf?.name!=="argon2id"||d.kdf.memory!==65536||d.kdf.iterations!==3||d.kdf.parallelism!==4||typeof d.kdf.salt!=="string"||unbase64(d.kdf.salt).length!==16)throw new Error("金庫の形式に対応していません。");
 for(const box of [d.password,d.recovery])if(!box||box.v!==1||typeof box.iv!=="string"||unbase64(box.iv).length!==12||typeof box.ciphertext!=="string"||unbase64(box.ciphertext).length!==48)throw new Error("金庫の鍵情報を確認できません。");
 return structuredClone(d);
}
async function aes(bytes:Uint8Array){return crypto.subtle.importKey("raw",new Uint8Array(bytes),"AES-GCM",false,["encrypt","decrypt"]);}
async function derive(password:string,d:VaultDescriptor["kdf"]){
 const bytes=await argon2id({password,salt:unbase64(d.salt),parallelism:d.parallelism,iterations:d.iterations,memorySize:d.memory,hashLength:32,outputType:"binary"});
 try{return await aes(bytes);}finally{bytes.fill(0);}
}
async function seal(key:CryptoKey,bytes:Uint8Array,context:string):Promise<CipherBox>{const iv=random(12);return {v:1,iv:base64(iv),ciphertext:base64(new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:encoder.encode(context),tagLength:128},key,new Uint8Array(bytes))))};}
async function open(key:CryptoKey,box:CipherBox,context:string){
 if(!box||box.v!==1||typeof box.iv!=="string"||typeof box.ciphertext!=="string"||unbase64(box.iv).length!==12||box.ciphertext.length>100*1024*1024)throw new Error("暗号文の形式を確認できません。");
 return new Uint8Array(await crypto.subtle.decrypt({name:"AES-GCM",iv:unbase64(box.iv),additionalData:encoder.encode(context),tagLength:128},key,unbase64(box.ciphertext)));
}
async function activate(descriptor:VaultDescriptor,raw:Uint8Array,before:number){
 try{const seed=await crypto.subtle.importKey("raw",new Uint8Array(raw),"HKDF",false,["deriveKey"]),params=(label:string)=>({name:"HKDF",hash:"SHA-256",salt:encoder.encode(descriptor.id),info:encoder.encode(label)}),key=await crypto.subtle.deriveKey(params("personal-tools:data:v1"),seed,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]),indexKey=await crypto.subtle.deriveKey(params("personal-tools:paths:v1"),seed,{name:"HMAC",hash:"SHA-256",length:256},false,["sign"]);
 if(epoch!==before)throw new Error("金庫の状態が変わりました。もう一度解錠してください。");
 session={descriptor,key,indexKey,epoch:++epoch,unlockedAt:Date.now()};for(const listener of subscribers)listener();return session;}finally{raw.fill(0);}
}
export async function createVault(password:string){
 const before=epoch;
 if(password.length<16||password.length>1024)throw new Error("専用のパスフレーズを16文字以上で設定してください。");
 const raw=random(32),recovery=random(32),id=crypto.randomUUID(),kdf={name:"argon2id" as const,memory:65536 as const,iterations:3 as const,parallelism:4 as const,salt:base64(random(16))};
 try{
  const descriptor:VaultDescriptor={version:1,id,kdf,password:await seal(await derive(password,kdf),raw,`vault:${id}:password`),recovery:await seal(await aes(recovery),raw,`vault:${id}:recovery`)};
  const recoveryKey=Array.from(recovery,b=>b.toString(16).padStart(2,"0")).join("").match(/.{8}/g)!.join("-");
  await activate(descriptor,raw,before);return {descriptor,recoveryKey};
 }finally{raw.fill(0);recovery.fill(0);}
}
export async function unlockVault(value:unknown,secret:string,recovery=false){
 const before=epoch;
 const descriptor=validateDescriptor(value);let raw:Uint8Array;
 try{
  if(recovery){const hex=secret.replace(/[-\s]/g,"");if(!/^[a-f0-9]{64}$/i.test(hex))throw new Error();const bytes=Uint8Array.from(hex.match(/../g)!,v=>parseInt(v,16));try{raw=await open(await aes(bytes),descriptor.recovery,`vault:${descriptor.id}:recovery`);}finally{bytes.fill(0);}}
  else raw=await open(await derive(secret,descriptor.kdf),descriptor.password,`vault:${descriptor.id}:password`);
 }catch{throw new Error("パスフレーズ・復旧鍵が違うか、鍵情報が破損しています。");}
 return activate(descriptor,raw,before);
}
async function pack(value:unknown):Promise<unknown>{
 const jobs:Promise<void>[]=[];
 function visit(v:unknown):unknown{
  if(v instanceof Blob){const out={$vaultBlob:1,mime:v.type,data:""};jobs.push(v.arrayBuffer().then(bytes=>{out.data=base64(new Uint8Array(bytes));}));return out;}
  if(Array.isArray(v))return v.map(visit);
  if(v&&typeof v==="object")return Object.fromEntries(Object.entries(v).map(([k,item])=>[k,visit(item)]));
  return v;
 }
 const result=visit(value);await Promise.all(jobs);return result;
}
function unpack(value:unknown):unknown{if(Array.isArray(value))return value.map(unpack);if(value&&typeof value==="object"){const o=value as Record<string,unknown>;if(o.$vaultBlob===1&&typeof o.data==="string"&&typeof o.mime==="string")return new Blob([unbase64(o.data)],{type:o.mime});return Object.fromEntries(Object.entries(o).map(([k,v])=>[k,unpack(v)]));}return value;}
export async function encryptVault(value:unknown,context:string,current=requireVault()){assertVault(current);const bytes=encoder.encode(JSON.stringify(await pack(value)));try{if(bytes.byteLength>75*1024*1024-16)throw new Error("暗号化するデータが大きすぎます。分けて保存してください。");const box=await seal(current.key,bytes,`personal-tools:v1:${current.descriptor.id}:${context}`);assertVault(current);return box;}finally{bytes.fill(0);}}
export async function decryptVault<T>(box:CipherBox,context:string,current=requireVault()):Promise<T>{assertVault(current);const bytes=await open(current.key,box,`personal-tools:v1:${current.descriptor.id}:${context}`);try{const result=unpack(JSON.parse(decoder.decode(bytes))) as T;assertVault(current);return result;}finally{bytes.fill(0);}}
export async function encryptBackup(value:unknown){const s=requireVault();return JSON.stringify({format:"personal-tools.encrypted-backup",version:1,vault:s.descriptor,box:await encryptVault(value,"backup",s)});}
export async function decryptBackup(value:unknown){const v=value as {format?:string;vault?:VaultDescriptor;box?:CipherBox};if(v?.format!=="personal-tools.encrypted-backup")return value;if(v.vault?.id!==requireVault().descriptor.id)throw new Error("このバックアップの金庫を先に解錠してください。");return decryptVault(v.box!,"backup");}
export async function vaultBlobPath(owner:string,item:string,identity:string){const s=requireVault();const digest=await crypto.subtle.sign("HMAC",s.indexKey,encoder.encode(`blob:${owner}:${item}:${identity}`));assertVault(s);return `${owner}/${s.descriptor.id}/${base64(new Uint8Array(digest)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"")}.bin`;}
export async function vaultCommitment(value:unknown,context:string,current=requireVault()){
 const stable=(v:any):any=>Array.isArray(v)?v.map(stable):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
 const signature=await crypto.subtle.sign("HMAC",current.indexKey,encoder.encode(`commitment:${context}:${JSON.stringify(stable(value))}`));assertVault(current);return base64(new Uint8Array(signature));
}
export async function readVaultDescriptor():Promise<VaultDescriptor|null>{return configRequest("readonly",store=>store.get("descriptor")).then(v=>v?validateDescriptor(v):null);}
export async function saveVaultDescriptor(value:VaultDescriptor){
 const d=validateDescriptor(value);let mismatch=false;
 try{await configRequest("readwrite",store=>{const r=store.get("descriptor");r.onsuccess=()=>{if(r.result){if(r.result.id!==d.id){mismatch=true;store.transaction.abort();}return;}store.put(d,"descriptor");};return r;});}
 catch(e){if(mismatch)throw new Error("この端末には別の金庫があります。既存の金庫を解錠してください。");throw e;}
}
async function configRequest(mode:IDBTransactionMode,work:(store:IDBObjectStore)=>IDBRequest):Promise<any>{
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open("personal-tools-vault-config",1);r.onupgradeneeded=()=>r.result.createObjectStore("config");r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 try{return await new Promise((resolve,reject)=>{const tx=db.transaction("config",mode),r=work(tx.objectStore("config"));tx.oncomplete=()=>resolve(r.result);tx.onabort=tx.onerror=()=>reject(tx.error??new Error("鍵情報を保存できません。"));});}finally{db.close();}
}
