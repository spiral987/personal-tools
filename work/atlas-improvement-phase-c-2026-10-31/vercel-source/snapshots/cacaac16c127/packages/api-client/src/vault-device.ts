import type {VaultDescriptor,VaultSession} from "./vault.ts";
export const VAULT_DAY_MS=24*60*60*1000;
export const VAULT_REVOCATION_KEY="personal-tools-vault-revocation-v1";
export const VAULT_POLICY_KEY="personal-tools-vault-lock-policy-v1";
export type VaultLockPolicy="daily"|"short";
export type RememberedVault={id:"active";scope:string;token:string;descriptorDigest:string;issuedAt:number;expiresAt:number;key:CryptoKey;indexKey:CryptoKey};
const DB="personal-tools-vault-device-v1";
export function vaultScope(projectUrl:string|null,accountId:string|null){
  let origin="device";
  if(projectUrl){const url=new URL(projectUrl);if(url.username||url.password||url.pathname!=="/"||url.search||url.hash||url.protocol!=="https:"&&!(["localhost","127.0.0.1","[::1]"].includes(url.hostname)&&url.protocol==="http:"))throw new Error("同期先を確認できません。");origin=url.origin;}
  if(accountId&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(accountId))throw new Error("アカウントを確認できません。");
  return JSON.stringify([origin,accountId?.toLowerCase()??"device"]);
}
export function readVaultPolicy():VaultLockPolicy{try{return localStorage.getItem(VAULT_POLICY_KEY)==="short"?"short":"daily";}catch{return "short";}}
export function writeVaultPolicy(policy:VaultLockPolicy){if(policy!=="daily"&&policy!=="short")throw new Error("解錠設定を確認してください。");localStorage.setItem(VAULT_POLICY_KEY,policy);}
export function deviceRevocationToken(create=false):string|null{
  try{
    let token=localStorage.getItem(VAULT_REVOCATION_KEY);
    if(!token&&create){token=crypto.randomUUID();localStorage.setItem(VAULT_REVOCATION_KEY,token);}
    return token;
  }catch{if(create)throw new Error("このブラウザでは24時間の解錠保持を利用できません。短時間ロックをご利用ください。");return null;}
}
export function deviceTokenIsCurrent(token:string){return deviceRevocationToken()===token;}
async function descriptorDigest(descriptor:VaultDescriptor){
  const stable=(value:any):any=>Array.isArray(value)?value.map(stable):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
  const bytes=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(stable(descriptor)))));
  return Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
}
async function database(){
  return new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>r.result.createObjectStore("session",{keyPath:"id"});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.onblocked=()=>reject(new Error("ほかのツールを閉じて、解錠保持を再設定してください。"));});
}
async function stored<T>(mode:IDBTransactionMode,work:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T>{
  const db=await database();
  try{return await new Promise<T>((resolve,reject)=>{const tx=db.transaction("session",mode,{durability:"strict"});let request:IDBRequest<T>;
    try{request=work(tx.objectStore("session"));}catch(error){tx.abort();reject(error);return;}
    tx.oncomplete=()=>resolve(request.result);tx.onabort=tx.onerror=()=>reject(tx.error??new Error("解錠保持を保存できませんでした。"));
  });}finally{db.close();}
}
function validKeys(record:Pick<RememberedVault,"key"|"indexKey">){
  const a=record.key,b=record.indexKey;
  return a?.extractable===false&&a.type==="secret"&&a.algorithm.name==="AES-GCM"&&(a.algorithm as AesKeyAlgorithm).length===256&&[...a.usages].sort().join() === "decrypt,encrypt"&&
    b?.extractable===false&&b.type==="secret"&&b.algorithm.name==="HMAC"&&(b.algorithm as HmacKeyAlgorithm).hash.name==="SHA-256"&&(b.algorithm as HmacKeyAlgorithm).length===256&&b.usages.join()==="sign";
}
async function verifyKeys(record:Pick<RememberedVault,"key"|"indexKey">){
  if(!validKeys(record))throw new Error("端末の解錠情報を確認できません。");
  const iv=crypto.getRandomValues(new Uint8Array(12)),data=new Uint8Array([1,2,3]);
  const cipher=await crypto.subtle.encrypt({name:"AES-GCM",iv},record.key,data);
  await crypto.subtle.decrypt({name:"AES-GCM",iv},record.key,cipher);
  await crypto.subtle.sign("HMAC",record.indexKey,data);
}
export async function rememberVault(current:VaultSession,scope:string,token:string){
  const issuedAt=current.unlockedAt,expiresAt=issuedAt+VAULT_DAY_MS;
  if(!Number.isFinite(issuedAt)||Date.now()<issuedAt||Date.now()>=expiresAt||!deviceTokenIsCurrent(token))throw new Error("解錠の期限または端末の状態が変わりました。もう一度解錠してください。");
  await verifyKeys(current);
  const record:RememberedVault={id:"active",scope,token,issuedAt,expiresAt,key:current.key,indexKey:current.indexKey,descriptorDigest:await descriptorDigest(current.descriptor)};
  await stored("readwrite",store=>{if(!deviceTokenIsCurrent(token))throw new Error("金庫をロックしました。");return store.put(record);});
  // Check that the browser persisted usable, non-extractable CryptoKeys.
  const restored=await stored<RememberedVault|undefined>("readonly",store=>store.get("active"));
  if(!restored||!validKeys(restored)||restored.token!==token||restored.scope!==scope||restored.issuedAt!==issuedAt||restored.descriptorDigest!==record.descriptorDigest||Date.now()<issuedAt||Date.now()>=expiresAt||!deviceTokenIsCurrent(token))throw new Error("このブラウザでは解錠保持を確認できませんでした。");
  current.scope=scope;current.expiresAt=expiresAt;current.retentionToken=token;
  return expiresAt;
}
export async function loadRememberedVault(descriptor:VaultDescriptor,scope:string):Promise<RememberedVault|null>{
  const record=await stored<RememberedVault|undefined>("readonly",store=>store.get("active"));if(!record)return null;
  const invalid=record.scope!==scope||!deviceTokenIsCurrent(record.token)||!Number.isFinite(record.issuedAt)||Date.now()<record.issuedAt||record.expiresAt!==record.issuedAt+VAULT_DAY_MS||Date.now()>=record.expiresAt||record.descriptorDigest!==await descriptorDigest(descriptor);
  if(invalid){await discardRecord(record);return null;}
  try{await verifyKeys(record);}catch{await discardRecord(record);return null;}
  return deviceTokenIsCurrent(record.token)?record:null;
}
async function discardRecord(record:RememberedVault){
  await stored("readwrite",store=>{const request=store.get("active");request.onsuccess=()=>{const current=request.result as RememberedVault|undefined;if(current&&current.token===record.token&&current.issuedAt===record.issuedAt&&current.scope===record.scope&&current.descriptorDigest===record.descriptorDigest)store.delete("active");};return request;});
}
/** Rotate a non-secret synchronous marker before deleting the persistent keys.
 * Even if the browser closes during deletion, a stale key cannot be resumed. */
export function revokeRememberedVault():Promise<void>{
  let token:string|null=null;try{token=crypto.randomUUID();localStorage.setItem(VAULT_REVOCATION_KEY,token);}catch{}
  if(typeof indexedDB==="undefined")return Promise.resolve();
  return stored("readwrite",store=>{
    const r=store.get("active");r.onsuccess=()=>{if(r.result&&r.result.token!==token)store.delete("active");};return r;
  }).then(()=>{});
}
