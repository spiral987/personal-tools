import type {AccountRecallRepository} from "./repository.ts";
import {createEncryptedSyncTransport,createSupabaseSyncTransport,createSyncEngine} from "./sync.ts";
import {assertVault,decryptVault,encryptVault,requireVault,type VaultDescriptor,type CipherBox} from "./vault.ts";
import {downloadResourceOriginal} from "./resource-files.ts";
import {downloadEncryptedResourceOriginal,uploadEncryptedResourceOriginal} from "./vault-files.ts";
import type {Resource,SyncRecord} from "@personal-tools/core";
// Supabase's fluent query builder is kept behind this one integration boundary.
export type VaultCloudClient={rpc(name:string,args?:Record<string,unknown>):PromiseLike<{data:any;error:any}>;from(name:string):any;storage:any};
const SOURCES=['items','notes','spaces','item_spaces','sketches','resources','relations','assets','projects','project_items','item_labels','sync_changes','sync_operations','sync_conflicts'];
export async function cloudVaultDescriptor(client:VaultCloudClient,owner:string):Promise<VaultDescriptor|null>{const r=await client.from("vault_keys").select("descriptor").eq("owner_id",owner).maybeSingle();if(r.error)throw new Error("暗号化同期の接続を確認できません。接続設定を確認してください。");return r.data?.descriptor??null;}
export async function prepareCloudVault(client:VaultCloudClient,repo:AccountRecallRepository,isCurrent:()=>boolean){
 const vault=requireVault(),owner=repo.ownerId;const check=()=>{assertVault(vault);if(!isCurrent())throw new Error("保存先が変わったため移行を中断しました。");};
 check();const registered=await client.rpc("register_vault",{p_descriptor:vault.descriptor});check();if(registered.error)throw new Error("このアカウントの金庫が異なるか、暗号化同期の準備ができていません。");
 if(registered.data?.migrated){
  if(await repo.isEncryptedSyncReady())return;
  const transport=createEncryptedSyncTransport(client,owner),remote=new Map<string,SyncRecord>();let cursor="0";
  for(let page=0;page<100000;page++){const result=await transport.pull(cursor,100);check();for(const c of result.changes)remote.set(`${c.entity}:${c.record.id}`,c.record);if(!result.hasMore)break;if(BigInt(result.cursor)<=BigInt(cursor))throw new Error("同期位置が進みません。");cursor=result.cursor;}
  await repo.prepareEncryptedSync([...remote.values()],"existing");return;
 }
 const legacy=createSupabaseSyncTransport(client,owner),records=new Map<string,SyncRecord>();let cursor="0";
 for(let page=0;page<100000;page++){const result=await legacy.pull(cursor,100);check();for(const c of result.changes)records.set(`${c.entity}:${c.record.id}`,c.record);if(!result.hasMore)break;if(BigInt(result.cursor)<=BigInt(cursor))throw new Error("既存データの移行位置を確認できません。");cursor=result.cursor;if(page===99999)throw new Error("移行件数が上限を超えています。");}
 // Preserve every server-side original, conflict and historical version in encrypted archives.
 for(const source of SOURCES){for(let page=0;page<100000;page++){
  const old=await client.rpc("legacy_vault_page",{p_source:source,p_page:page});check();if(old.error||!Array.isArray(old.data))throw new Error("既存データを読み出せません。元のデータは保持されています。");if(!old.data.length)break;
  const context=`archive:${owner}:${source}:${page}`,box=await encryptVault(old.data,context,vault);
  const saved=await client.rpc("store_vault_archive",{p_source:source,p_page:page,p_count:old.data.length,p_box:box});check();if(saved.error)throw new Error("暗号化アーカイブを保存できません。元のデータは保持されています。");
  const read=await client.from("vault_archives").select("box").eq("owner_id",owner).eq("source",source).eq("page",page).single();check();
  if(read.error||JSON.stringify(await decryptVault(read.data.box as CipherBox,context,vault))!==JSON.stringify(old.data))throw new Error("移行データを検証できません。元のデータは保持されています。");

 }}
 await repo.prepareEncryptedSync([...records.values()]);check();
 // Originals, including trashed resources, must survive before removing any legacy object.
 const snapshot=await repo.snapshot();
 for(const resource of [...records.values()].filter((r):r is Resource=>"kind" in r&&r.kind==="resource"&&!!r.image)){
  check();let blob:Blob;try{blob=await downloadEncryptedResourceOriginal(client,owner,resource,{isCurrent});}catch{
   blob=await repo.getResourceFile(resource.id)??await downloadResourceOriginal(client,owner,resource,{isCurrent});check();await uploadEncryptedResourceOriginal(client,owner,resource,blob,{isCurrent});
  }check();await repo.cacheResourceFile(resource.id,blob);
 }
 // Also cover originals created offline on this device before migration.
 for(const r of snapshot.resources){if(!r.image)continue;const blob=await repo.getResourceFile(r.id);if(blob){check();await uploadEncryptedResourceOriginal(client,owner,r,blob,{isCurrent});}}
 const engine=createSyncEngine(repo,createEncryptedSyncTransport(client,owner,{legacy:true}));try{const state=await engine.run();check();if(state.phase==="error"||state.pending)throw new Error("暗号化同期の完了待ちです。元のデータは保持されています。");}finally{engine.stop();}
 // List and delete through Storage API, never SQL, only after verified encrypted copies.
 const bucket=client.storage.from("personal-tools-private");
 for(const record of records.values()){
  if(!("kind" in record)||!["note","sketch","resource"].includes(record.kind))continue;
  for(const folder of ["originals","previews"]){const prefix=`${owner}/${record.id}/${folder}`;for(;;){const listed=await bucket.list(prefix,{limit:100});check();if(listed.error)throw new Error("旧画像の削除確認ができません。移行を再試行してください。");const files=(listed.data??[]).filter((f:{id?:string})=>f.id);if(!files.length)break;const removed=await bucket.remove(files.map((f:{name:string})=>`${prefix}/${f.name}`));check();if(removed.error)throw new Error("旧画像を削除できません。暗号化した原本は保存されています。");}}
 }
 const finished=await client.rpc("finish_vault_migration");check();if(finished.error)throw new Error("暗号化データは保存済みですが、旧データの整理が未完了です。再度同期してください。");
}
