import {MAX_RESOURCE_FILE_BYTES,parseResourceImage,type Resource,type ResourceImage,type ResourceMime} from "@personal-tools/core";
import type {SketchPreviewClient} from "./sketch-preview.ts";
export type ResourceOriginalClient=SketchPreviewClient;
export type ResourceOriginalScope={isCurrent?:()=>boolean;signal?:AbortSignal};
function assertCurrent(scope?:ResourceOriginalScope){
  if(scope?.signal?.aborted||scope?.isCurrent?.()===false)throw new DOMException("画像の処理を中断しました。","AbortError");
}
const extensions:Record<ResourceMime,string>={"image/png":"png","image/jpeg":"jpg","image/gif":"gif","image/webp":"webp"};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function dimensions(width:number,height:number){if(width<1||height<1||width>20000||height>20000||width*height>40000000)throw new Error("画像の大きさは4,000万画素以内にしてください。");}
function imageMime(bytes:Uint8Array):ResourceMime {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(bytes.length>=45&&[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v)&&String.fromCharCode(...bytes.subarray(12,16))==="IHDR"){
    dimensions(view.getUint32(16),view.getUint32(20));
    if(String.fromCharCode(...bytes.subarray(bytes.length-8,bytes.length-4))!=="IEND")throw new Error("PNGの原本を確認してください。");
    return "image/png";
  }
  if(bytes.length>=14&&["GIF87a","GIF89a"].includes(String.fromCharCode(...bytes.subarray(0,6)))&&bytes.at(-1)===0x3b){
    dimensions(view.getUint16(6,true),view.getUint16(8,true));return "image/gif";
  }
  if(bytes.length>=30&&String.fromCharCode(...bytes.subarray(0,4))==="RIFF"&&String.fromCharCode(...bytes.subarray(8,12))==="WEBP"&&view.getUint32(4,true)===bytes.length-8){
    const type=String.fromCharCode(...bytes.subarray(12,16));
    if(type==="VP8X")dimensions(1+bytes[24]+(bytes[25]<<8)+(bytes[26]<<16),1+bytes[27]+(bytes[28]<<8)+(bytes[29]<<16));
    else if(type==="VP8L"&&bytes[20]===0x2f)dimensions(1+bytes[21]+((bytes[22]&63)<<8),1+(bytes[22]>>6)+(bytes[23]<<2)+((bytes[24]&15)<<10));
    else if(type==="VP8 "&&bytes[23]===0x9d&&bytes[24]===1&&bytes[25]===0x2a)dimensions(view.getUint16(26,true)&0x3fff,view.getUint16(28,true)&0x3fff);
    else throw new Error("WebPの原本を確認してください。");
    return "image/webp";
  }
  if(bytes.length>=12&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes.at(-2)===255&&bytes.at(-1)===217){
    let offset=2;
    while(offset+8<bytes.length){
      if(bytes[offset]!==255)break;
      const marker=bytes[offset+1];if(marker===255){offset++;continue;}
      if(marker===0xd9||marker===0xda)break;
      if(marker===0xd8||(marker>=0xd0&&marker<=0xd7)){offset+=2;continue;}
      const size=view.getUint16(offset+2);if(size<2||offset+2+size>bytes.length)break;
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
        dimensions(view.getUint16(offset+7),view.getUint16(offset+5));return "image/jpeg";
      }
      offset+=2+size;
    }
  }
  throw new Error("PNG・JPEG・GIF・WebPの画像ファイルを選んでください。");
}
/** Hash the bounded original, never a resized preview.
 * https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest */
export async function prepareResourceImage(blob:Blob,filename?:string):Promise<ResourceImage>{
  if(!(blob instanceof Blob)||blob.size<8||blob.size>MAX_RESOURCE_FILE_BYTES)throw new Error("画像は20MB以下で選んでください。");
  const bytes=new Uint8Array(await blob.arrayBuffer()),mimeType=imageMime(bytes);
  if(blob.type&&blob.type.toLowerCase()!==mimeType)throw new Error("画像の種類と内容が一致しません。");
  const sha256=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),byte=>byte.toString(16).padStart(2,"0")).join("");
  return parseResourceImage({sha256,mimeType,size:blob.size,filename:filename??("name" in blob&&typeof blob.name==="string"?blob.name:"image."+extensions[mimeType])});
}
function assertOwned(userId:string,resource:Resource,allowDeleted=false){
  if(!uuid.test(userId)||!uuid.test(resource.id)||resource.ownerId!==userId||resource.resourceType!=="image"||!resource.image||
    !Number.isSafeInteger(resource.serverRevision)||Number(resource.serverRevision)<1||(!allowDeleted&&resource.deletedAt))throw new Error("先に画像資料をクラウドへ同期してください。");
}
export function getResourceStoragePath(userId:string,resource:Resource):string {
  if(!uuid.test(userId)||!uuid.test(resource.id)||!resource.image)throw new Error("画像の保存先を確認してください。");
  const image=parseResourceImage(resource.image);return userId+"/"+resource.id+"/originals/"+image.sha256+"."+extensions[image.mimeType];
}
/** Private, immutable originals. Storage duplicate errors are not generic failures to ignore.
 * https://supabase.com/docs/guides/storage/uploads/standard-uploads#overwriting-files */
export async function uploadResourceOriginal(client:ResourceOriginalClient,userId:string,resource:Resource,blob:Blob,scope?:ResourceOriginalScope):Promise<string>{
  assertCurrent(scope);assertOwned(userId,resource);const image=await prepareResourceImage(blob,resource.image!.filename);assertCurrent(scope);
  if(image.sha256!==resource.image!.sha256||image.size!==resource.image!.size||image.mimeType!==resource.image!.mimeType)throw new Error("原本の画像が保存情報と一致しません。");
  const path=getResourceStoragePath(userId,resource);
  const existing=await client.rpc("get_resource_original",{p_item_id:resource.id});
  assertCurrent(scope);
  if(existing.error)throw new Error("原本の保存状態を確認できませんでした。もう一度同期してください。");
  const known=existing.data as {path?:unknown;sha256?:unknown;size?:unknown;mimeType?:unknown;registered?:unknown}|null;
  if(known!==null){
    if(known.path!==path||known.sha256!==image.sha256||known.size!==image.size||known.mimeType!==image.mimeType)throw new Error("原本の保存状態が一致しません。");
    if(known.registered===true)return path;
    const registered=await client.rpc("register_resource_original",{p_item_id:resource.id,p_path:path,p_sha256:image.sha256,p_mime:image.mimeType,p_size:image.size});
    assertCurrent(scope);
    if(registered.error)throw new Error("原本の登録を確認できませんでした。もう一度同期してください。");
    return path;
  }
  const uploaded=await client.storage.from("personal-tools-private").upload(path,blob,{contentType:image.mimeType,upsert:false,cacheControl:"0"});
  assertCurrent(scope);
  const error=uploaded.error,status=String(error?.status??error?.statusCode);
  const code=[error?.code,error?.error,error?.statusCode].some(v=>["Duplicate","ResourceAlreadyExists","KeyAlreadyExists"].includes(String(v)));
  const duplicate=!!error&&["400","409"].includes(status)&&(code||["Asset Already Exists","The resource already exists","The resource already exists."].includes(error.message??""));
  if(error&&!duplicate)throw new Error("画像の原本を送信できませんでした。端末内の原本は残っています。");
  const registration=await client.rpc("register_resource_original",{p_item_id:resource.id,p_path:path,p_sha256:image.sha256,p_mime:image.mimeType,p_size:image.size});
  assertCurrent(scope);
  // Do not delete after uncertain replies: a successful registration may already have committed.
  if(registration.error)throw new Error("原本の登録を確認できませんでした。もう一度同期してください。");
  return path;
}
export async function downloadResourceOriginal(client:ResourceOriginalClient,userId:string,resource:Resource,scope?:ResourceOriginalScope):Promise<Blob>{
  assertCurrent(scope);assertOwned(userId,resource,true);
  const result=await client.rpc("get_resource_original",{p_item_id:resource.id});
  assertCurrent(scope);
  const data=result.data as {path?:unknown;sha256?:unknown}|null,path=getResourceStoragePath(userId,resource);
  if(result.error||!data||data.path!==path||data.sha256!==resource.image!.sha256)throw new Error("画像の原本はまだクラウドへ届いていません。元の端末で同期してください。");
  const downloaded=await client.storage.from("personal-tools-private").download(path);
  assertCurrent(scope);
  if(downloaded.error||!downloaded.data)throw new Error("画像の原本を取得できませんでした。");
  const image=await prepareResourceImage(downloaded.data,resource.image!.filename);
  assertCurrent(scope);
  if(image.sha256!==resource.image!.sha256||image.size!==resource.image!.size||image.mimeType!==resource.image!.mimeType)throw new Error("画像の原本を検証できませんでした。");
  return downloaded.data;
}
export async function blobToBase64(blob:Blob):Promise<string>{
  const bytes=new Uint8Array(await blob.arrayBuffer());let binary="";
  for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
  return btoa(binary);
}
export function base64ToBlob(data:string,mime:ResourceMime):Blob {
  const binary=atob(data),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);return new Blob([bytes],{type:mime});
}
