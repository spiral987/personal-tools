import {purgeDeadline,type SyncRecord} from "@personal-tools/core";
import {assertVault,decryptVault,requireVault,vaultBlobPath,vaultCommitment,type CipherBox} from "./vault.ts";
import type {VaultCloudClient} from "./vault-cloud.ts";

export type RetentionMetadata={version:1;purgeAt:string|null;spaceDeleted:boolean;relatedIds:string[];filePaths:string[]};
export async function retentionMetadata(record:SyncRecord,owner:string):Promise<RetentionMetadata>{
 const filePaths:string[]=[];
 if("kind" in record&&record.kind==="resource"&&record.image)filePaths.push(await vaultBlobPath(owner,record.id,record.image.sha256));
 if("kind" in record&&record.kind==="sketch"&&record.serverRevision)filePaths.push(await vaultBlobPath(owner,record.id,`preview:${record.serverRevision}`));
 return {version:1,purgeAt:purgeDeadline(record),spaceDeleted:!("kind" in record)&&!!record.deletedAt,relatedIds:"kind" in record&&record.kind==="relation"?[record.fromItemId,record.toItemId]:[],filePaths};
}
// Historical ciphertext is opened locally once. Only deadlines, opaque IDs and file paths leave the device.
export async function prepareVaultRetention(client:VaultCloudClient,owner:string,isCurrent:()=>boolean){
 const vault=requireVault();const check=()=>{assertVault(vault);if(!isCurrent())throw new Error("保存先が変わったため準備を中断しました。");};
 const rpc=async(name:string,args?:Record<string,unknown>)=>{check();const result=await client.rpc(name,args);check();if(result.error)throw new Error("ごみ箱の自動整理を準備できません。記録は保持されています。通信が戻ってから再試行してください。");return result.data;};
 if((await rpc("begin_vault_retention"))?.ready)return;
 for(const source of ["records","changes","operations","archives"]){
  for(let page=0;page<100000;page++){
   const rows=await rpc("vault_retention_page",{p_source:source});if(!Array.isArray(rows))throw new Error("整理用の情報を確認できません。");if(!rows.length)break;
   for(const row of rows){
    if(source==="archives"){
     const values=await decryptVault<Record<string,any>[]>(row.box,`archive:${owner}:${row.source}:${row.page}`,vault),ids=new Set<string>();
     for(const value of values){
      // Archives use one original row per page. Never index owner IDs or arbitrary body strings.
      const keys=["item_id","entity_id","from_item_id","to_item_id"];
      if(["items","spaces","projects","relations"].includes(row.source))keys.push("id");
      for(const key of keys)if(typeof value[key]==="string"&&/^[A-Za-z0-9_-]{1,100}$/.test(value[key]))ids.add(value[key]);
     }
     await rpc("index_vault_retention",{p_source:source,p_row:{...row,ids:[...ids]}});
    }else{
     const context=`sync:${JSON.stringify([owner,row.entity,row.id])}`,payload=await decryptVault<SyncRecord>(row.box as CipherBox,context,vault);
     if(payload.ownerId!==owner||payload.id!==row.id||("kind" in payload?payload.kind:"space")!==row.entity)throw new Error("整理対象の所有者を確認できません。");
     const retention=await retentionMetadata({...payload,...(row.revision?{serverRevision:row.revision}:{})},owner);
     let canonicalRetention=retention;
     if(row.canonical){const canonical=await decryptVault<SyncRecord>(row.canonical.box,context,vault);canonicalRetention=await retentionMetadata({...canonical,serverRevision:row.canonical.revision},owner);}
     await rpc("index_vault_retention",{p_source:source,p_row:{...row,retention,canonicalRetention,...(source==="operations"?{commitment:await vaultCommitment({payload,retention},`operation:${owner}:${row.key}`,vault)}:{})}});
    }
   }
   if(page===99999)throw new Error("整理の準備件数が上限を超えています。");
  }
 }
 await rpc("finish_vault_retention");
}
