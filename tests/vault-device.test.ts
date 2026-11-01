import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {createVault,requireVault,clearVaultMemory,resumeVault,encryptVault,decryptVault,unlockVault,lockVault,beforeVaultLock,requestVaultLock} from "../packages/api-client/src/vault.ts";
import {VAULT_DAY_MS,deviceRevocationToken,rememberVault,revokeRememberedVault,vaultScope,readVaultPolicy,writeVaultPolicy} from "../packages/api-client/src/vault-device.ts";
const storage=new Map<string,string>();
Object.defineProperty(globalThis,"localStorage",{configurable:true,value:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,String(value)),removeItem:(key:string)=>storage.delete(key)}});
const password="device-retention-test-passphrase-only";
const scope=vaultScope("https://example.supabase.co","11111111-1111-4111-8111-111111111111");
async function remember(){const current=requireVault();await rememberVault(current,scope,deviceRevocationToken(true)!);return current;}
async function record(){const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open("personal-tools-vault-device-v1",1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});try{return await new Promise<any>((resolve,reject)=>{const r=db.transaction("session").objectStore("session").get("active");r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}finally{db.close();}}

test("device retention: native structured keys resume encrypted content with fixed 24h expiry",async()=>{
 const {descriptor}=await createVault(password),box=await encryptVault({body:"保持する秘密"},"device-test");
 const first=await remember(),expiry=first.expiresAt;clearVaultMemory();
 const restored=await resumeVault(descriptor,scope);assert.ok(restored);assert.equal(restored.expiresAt,expiry);assert.equal(restored.expiresAt!-restored.unlockedAt,VAULT_DAY_MS);
 assert.deepEqual(await decryptVault(box,"device-test"),{body:"保持する秘密"});
 for(const key of [restored.key,restored.indexKey]){assert.equal(key.extractable,false);await assert.rejects(crypto.subtle.exportKey("raw",key));}
 const row=await record();assert.deepEqual(Object.keys(row).sort(),["descriptorDigest","expiresAt","id","indexKey","issuedAt","key","scope","token"].sort());
 assert.ok(!JSON.stringify(row).includes(password));
});
test("device retention: account, project and modified descriptor cannot reuse a key",async()=>{
 const {descriptor}=await createVault(password);
 for(const other of [vaultScope("https://example.supabase.co","22222222-2222-4222-8222-222222222222"),vaultScope("https://other.supabase.co","11111111-1111-4111-8111-111111111111")]){
  await remember();clearVaultMemory();assert.equal(await resumeVault(descriptor,other),null);assert.equal(await record(),undefined);await unlockVault(descriptor,password);
 }
 await remember();clearVaultMemory();const changed=structuredClone(descriptor);changed.password.ciphertext=(changed.password.ciphertext[0]==="A"?"B":"A")+changed.password.ciphertext.slice(1);assert.equal(await resumeVault(changed,scope),null);
});
test("device retention: expiry and backwards clock remove persistent keys",async()=>{
 const {descriptor}=await createVault(password),realNow=Date.now;
 for(const offset of [-1,VAULT_DAY_MS]){
  const current=await remember();clearVaultMemory();Date.now=()=>current.unlockedAt+offset;
  try{assert.equal(await resumeVault(descriptor,scope),null);assert.equal(await record(),undefined);}finally{Date.now=realNow;}
  await unlockVault(descriptor,password);
 }
});
test("device retention: manual lock removes persisted keys and blocks a pending password unlock",async()=>{
 const {descriptor}=await createVault(password);await remember();await requestVaultLock();assert.equal(await record(),undefined);assert.equal(await resumeVault(descriptor,scope),null);
 const pending=unlockVault(descriptor,password);lockVault();await assert.rejects(pending,/状態が変わり/);assert.throws(requireVault);
});
test("device retention: failed draft save keeps input unlocked; forced expiry revokes it",async()=>{
 const {descriptor}=await createVault(password);await remember();const stop=beforeVaultLock(async()=>{throw new Error("disk full");});
 try{await assert.rejects(requestVaultLock(),/下書き/);assert.ok(requireVault());assert.ok(await record());await assert.rejects(requestVaultLock({force:true}));assert.throws(requireVault);assert.equal(await record(),undefined);assert.equal(await resumeVault(descriptor,scope),null);}finally{stop();}
});
test("device retention: revocation is synchronous and short preference remains available",async()=>{
 await createVault(password);const current=await remember(),token=current.retentionToken;
 const revoked=revokeRememberedVault();assert.notEqual(deviceRevocationToken(),token);assert.throws(requireVault,/ロック/);await revoked;
 writeVaultPolicy("short");assert.equal(readVaultPolicy(),"short");writeVaultPolicy("daily");assert.equal(readVaultPolicy(),"daily");
 assert.throws(()=>vaultScope("http://remote.example",null));assert.throws(()=>vaultScope(null,"invalid-account"));
});
test("device retention: extractable or corrupt persisted keys are rejected and removed",async()=>{
 const {descriptor}=await createVault(password);await remember();const row=await record();
 row.key=await crypto.subtle.generateKey({name:"AES-GCM",length:256},true,["encrypt","decrypt"]);
 const db=await new Promise<IDBDatabase>(resolve=>{const r=indexedDB.open("personal-tools-vault-device-v1");r.onsuccess=()=>resolve(r.result);});
 await new Promise<void>((resolve,reject)=>{const tx=db.transaction("session","readwrite");tx.objectStore("session").put(row);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});db.close();
 clearVaultMemory();assert.equal(await resumeVault(descriptor,scope),null);assert.equal(await record(),undefined);
});
test("device retention: revocation during an in-flight persistence operation cannot restore a key",async()=>{
 await createVault(password);const current=requireVault(),pending=rememberVault(current,scope,deviceRevocationToken(true)!);
 const revoked=revokeRememberedVault();await assert.rejects(pending);await revoked;assert.equal(await record(),undefined);
});
test("device retention: a key deletion failure still closes memory after the synchronous revocation",async()=>{
 const {descriptor}=await createVault(password);await remember();const original=indexedDB;
 Object.defineProperty(globalThis,"indexedDB",{configurable:true,value:{open(){throw new Error("storage unavailable");}}});
 try{await assert.rejects(requestVaultLock(),/storage unavailable/);assert.throws(requireVault);}finally{Object.defineProperty(globalThis,"indexedDB",{configurable:true,value:original});}
 assert.equal(await resumeVault(descriptor,scope),null);assert.equal(await record(),undefined);
});
