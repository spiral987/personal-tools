import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {createVault,requireVault,lockVault,unlockVault,encryptVault,decryptVault,encryptBackup,decryptBackup,beforeVaultLock,requestVaultLock,saveVaultDescriptor,readVaultDescriptor} from "../packages/api-client/src/vault.ts";
import {openRecallRepository} from "../packages/api-client/src/repository.ts";
import {uploadEncryptedResourceOriginal,downloadEncryptedResourceOriginal} from "../packages/api-client/src/vault-files.ts";
import {prepareResourceImage} from "../packages/api-client/src/resource-files.ts";
import {PNG} from "./helpers/vault-fixtures.ts";
const pass="a long test passphrase only for the test suite";

test("vault: fresh authenticated encryption rejects tampering and record/owner substitution",async()=>{
 const a=await encryptVault({body:"私有情報"},"record:A"),b=await encryptVault({body:"私有情報"},"record:A");assert.notEqual(a.iv,b.iv);assert.notEqual(a.ciphertext,b.ciphertext);
 assert.deepEqual(await decryptVault(a,"record:A"),{body:"私有情報"});await assert.rejects(decryptVault(a,"record:B"));
 const changed={...a,ciphertext:(a.ciphertext[0]==="A"?"B":"A")+a.ciphertext.slice(1)};await assert.rejects(decryptVault(changed,"record:A"));
 assert.equal(requireVault().key.extractable,false);await assert.rejects(crypto.subtle.exportKey("raw",requireVault().key));
});
test("vault: password and offline recovery open the same data; wrong credentials and lock fail closed",async()=>{
 const {descriptor,recoveryKey}=await createVault(pass),box=await encryptVault({memo:"復旧できる"},"recovery-test");lockVault();await assert.rejects(encryptVault({},"locked"));
 await assert.rejects(unlockVault(descriptor,"incorrect passphrase"));await unlockVault(descriptor,pass);assert.deepEqual(await decryptVault(box,"recovery-test"),{memo:"復旧できる"});
 lockVault();await unlockVault(descriptor,recoveryKey,true);assert.deepEqual(await decryptVault(box,"recovery-test"),{memo:"復旧できる"});
});
test("vault: drafts, originals, outbox and conflicts are ciphertext in the actual IndexedDB",async()=>{
 const name=`test-vault-${crypto.randomUUID()}`,repo=await openRecallRepository(name);await repo.saveNote({body:"秘密の原本",spaceIds:[]});await repo.saveDraft("秘密の下書き",[]);await repo.saveRecallEditDraft({noteId:crypto.randomUUID(),body:"秘密の編集中",spaceIds:[],revision:1});
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open(name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 for(const store of Array.from(db.objectStoreNames)){const rows=await new Promise<any[]>((resolve,reject)=>{const r=db.transaction(store).objectStore(store).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});for(const row of rows){assert.deepEqual(Object.keys(row).sort(),["id","sealed","vault"]);assert.ok(!JSON.stringify(row).includes("秘密"));}}
 db.close();repo.close();const reopened=await openRecallRepository(name);assert.equal((await reopened.loadDraft()).body,"秘密の下書き");assert.equal((await reopened.loadRecallEditDraft())?.body,"秘密の編集中");assert.equal((await reopened.snapshot()).notes[0].body,"秘密の原本");reopened.close();
});
test("vault: encrypted backup round trip hides content and authenticates the payload",async()=>{
 const encoded=await encryptBackup({format:"test",notes:[{body:"バックアップの秘密"}]});assert.ok(!encoded.includes("バックアップの秘密"));assert.deepEqual(await decryptBackup(JSON.parse(encoded)),{format:"test",notes:[{body:"バックアップの秘密"}]});
 const changed=JSON.parse(encoded);changed.box.iv=btoa("000000000000");await assert.rejects(decryptBackup(changed));
});
test("vault: image storage contains only encrypted octet streams and round trips exact original bytes",async()=>{
 const blob=new Blob([PNG],{type:"image/png"}),image=await prepareResourceImage(blob,"私有画像.png"),owner="11111111-1111-4111-8111-111111111111";
 const resource={id:crypto.randomUUID(),kind:"resource",originApp:"collect",ownerId:owner,resourceType:"image",image} as any;
 const objects=new Map<string,Blob>();const client={rpc:async(name:string)=>{assert.equal(name,"register_vault_file");return {data:null,error:null};},storage:{from(bucket:string){assert.equal(bucket,"personal-tools-vault");return {upload:async(path:string,value:Blob,options:any)=>{assert.equal(options.contentType,"application/octet-stream");assert.ok(!path.includes(image.sha256));assert.ok(!await value.text().then(v=>v.includes("私有画像")));objects.set(path,value);return {data:{},error:null};},download:async(path:string)=>({data:objects.get(path)??null,error:null}),remove:async()=>({data:{},error:null})};}}};
 await uploadEncryptedResourceOriginal(client,owner,resource,blob);const restored=await downloadEncryptedResourceOriginal(client,owner,resource);assert.deepEqual(new Uint8Array(await restored.arrayBuffer()),PNG);
 const path=[...objects.keys()][0];objects.set(path,new Blob(["corrupt"]));await assert.rejects(downloadEncryptedResourceOriginal(client,owner,resource));
});
test("vault: locking flushes registered drafts, invalidates open repositories, and never falls back to plaintext",async()=>{
 const {descriptor,recoveryKey}=await createVault(pass),name=`test-vault-lock-${crypto.randomUUID()}`,repo=await openRecallRepository(name);const stop=beforeVaultLock(()=>repo.saveDraft("ロック直前",[]));await requestVaultLock();stop();await assert.rejects(repo.snapshot());await assert.rejects(openRecallRepository(`locked-${crypto.randomUUID()}`));repo.close();await unlockVault(descriptor,recoveryKey,true);const reopened=await openRecallRepository(name);assert.equal((await reopened.loadDraft()).body,"ロック直前");reopened.close();
});
test("vault: backup headers cannot overwrite an existing key descriptor, and a wrong key cannot modify an encrypted database",async()=>{
 const first=await createVault(pass),name=`test-vault-wrong-key-${crypto.randomUUID()}`,repo=await openRecallRepository(name);await repo.saveNote({body:"間違った鍵から守る原本",spaceIds:[]});repo.close();await saveVaultDescriptor(first.descriptor);
 const second=await createVault(pass);await assert.rejects(saveVaultDescriptor(second.descriptor));const forged={...second.descriptor,id:first.descriptor.id};await saveVaultDescriptor(forged);assert.deepEqual(await readVaultDescriptor(),first.descriptor);
 requireVault().descriptor.id=first.descriptor.id;await assert.rejects(openRecallRepository(name));await unlockVault(first.descriptor,pass);const restored=await openRecallRepository(name);assert.equal((await restored.snapshot()).notes[0].body,"間違った鍵から守る原本");restored.close();
});
