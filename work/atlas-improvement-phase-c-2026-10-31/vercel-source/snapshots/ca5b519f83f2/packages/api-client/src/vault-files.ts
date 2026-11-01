import {assertVault,decryptVault,encryptVault,requireVault,vaultBlobPath,type CipherBox} from "./vault.ts";
import {prepareResourceImage,type ResourceOriginalScope} from "./resource-files.ts";
import type {SketchPreviewClient} from "./sketch-preview.ts";
import type {Resource,Sketch} from "@personal-tools/core";
const BUCKET="personal-tools-vault";
function scopeCheck(scope?:ResourceOriginalScope){if(scope?.signal?.aborted||scope?.isCurrent?.()===false)throw new Error("画像の処理を中断しました。");}
export async function uploadVaultBlob(client:SketchPreviewClient,owner:string,item:string,identity:string,blob:Blob,scope?:ResourceOriginalScope){
 const vault=requireVault();scopeCheck(scope);const path=await vaultBlobPath(owner,item,identity),box=await encryptVault({blob},`file:${path}`,vault);scopeCheck(scope);
 const registered=await client.rpc("register_vault_file",{p_entity:identity.startsWith("preview:")?"sketch":"resource",p_id:item,p_path:path});assertVault(vault);scopeCheck(scope);if(registered.error)throw new Error("画像の保存先を登録できません。記録が削除されていないか確認してください。");
 const result=await client.storage.from(BUCKET).upload(path,new Blob([JSON.stringify(box)],{type:"application/octet-stream"}),{contentType:"application/octet-stream",upsert:false,cacheControl:"0"});assertVault(vault);scopeCheck(scope);
 if(result.error){const status=String(result.error.status??result.error.statusCode);if(!["400","409"].includes(status)||!["Duplicate","ResourceAlreadyExists","KeyAlreadyExists","Asset Already Exists","The resource already exists","The resource already exists."].includes(String(result.error.code??result.error.error??result.error.message)))throw new Error("暗号化した画像を送信できません。");}
 // Read and decrypt the committed object even on duplicate/retry before reporting success.
 const verified=await downloadVaultBlob(client,path,scope);if(verified.size!==blob.size||verified.type!==blob.type||await digest(verified)!==await digest(blob))throw new Error("暗号化した画像の検証に失敗しました。");return path;
}
async function digest(blob:Blob){return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await blob.arrayBuffer())),b=>b.toString(16).padStart(2,"0")).join("");}
export async function downloadVaultBlob(client:SketchPreviewClient,path:string,scope?:ResourceOriginalScope){
 const vault=requireVault();scopeCheck(scope);const result=await client.storage.from(BUCKET).download(path);assertVault(vault);scopeCheck(scope);
 if(result.error||!result.data||result.data.size>40000000)throw new Error("暗号化した画像を取得できません。");const value=await decryptVault<{blob:Blob}>(JSON.parse(await result.data.text()) as CipherBox,`file:${path}`,vault);scopeCheck(scope);if(!(value.blob instanceof Blob))throw new Error("画像の形式を確認できません。");return value.blob;
}
export async function uploadEncryptedResourceOriginal(client:SketchPreviewClient,owner:string,resource:Resource,blob:Blob,scope?:ResourceOriginalScope){
 if(resource.ownerId!==owner||!resource.image)throw new Error("画像の所有者を確認できません。");const image=await prepareResourceImage(blob,resource.image.filename);if(image.sha256!==resource.image.sha256||image.size!==resource.image.size||image.mimeType!==resource.image.mimeType)throw new Error("画像の原本を確認できません。");return uploadVaultBlob(client,owner,resource.id,resource.image.sha256,blob,scope);
}
export async function downloadEncryptedResourceOriginal(client:SketchPreviewClient,owner:string,resource:Resource,scope?:ResourceOriginalScope){
 if(resource.ownerId!==owner||!resource.image)throw new Error("画像の所有者を確認できません。");const blob=await downloadVaultBlob(client,await vaultBlobPath(owner,resource.id,resource.image.sha256),scope),image=await prepareResourceImage(blob,resource.image.filename);if(image.sha256!==resource.image.sha256||image.size!==resource.image.size||image.mimeType!==resource.image.mimeType)throw new Error("画像の原本を検証できません。");return blob;
}
export async function uploadEncryptedSketchPreview(client:SketchPreviewClient,owner:string,sketch:Sketch,blob:Blob){if(sketch.ownerId!==owner||!sketch.serverRevision||blob.type!=="image/png"||blob.size>2097152)throw new Error("プレビューを確認できません。");return uploadVaultBlob(client,owner,sketch.id,`preview:${sketch.serverRevision}`,blob);}
