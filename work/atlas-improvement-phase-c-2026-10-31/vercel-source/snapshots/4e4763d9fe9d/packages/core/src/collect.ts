import {jsonbByteLength} from "./jsonb.ts";
import type {Space} from "./index.ts";

export type ResourceMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export type ResourceImage = {sha256:string;mimeType:ResourceMime;size:number;filename:string};
export type ResourceMetadata = {status:"none"|"pending"|"ready"|"failed";title:string;description:string;fetchedAt:string|null};
export type Resource = {
  id:string;kind:"resource";originApp:"collect";ownerId:string|null;resourceType:"link"|"image";
  url:string|null;sourceUrl:string|null;title:string;memo:string;spaceIds:string[];inbox:boolean;pinned:boolean;
  image:ResourceImage|null;metadata:ResourceMetadata;createdAt:string;updatedAt:string;deletedAt:string|null;
  localRevision:number;serverRevision:number|null;
};
export type CollectDraft = {
  resourceType:"link"|"image";url:string;sourceUrl:string;title:string;memo:string;spaceIds:string[];inbox:boolean;
  image:ResourceImage|null;editingId?:string;expectedRevision?:number;
};
export type ResourceMetadataJob = {id:string;token:string;resourceId:string;url:string;createdAt:string};
export type CollectBackupFile = ResourceImage & {data:string};
export type CollectBackup = {format:"personal-tools.collect";version:1;exportedAt:string;resources:Resource[];spaces:Space[];files:CollectBackupFile[]};
export const MAX_RESOURCE_FILE_BYTES = 20*1024*1024;
export const MAX_COLLECT_BACKUP_BYTES = 32*1024*1024;
export const MAX_COLLECT_BACKUP_JSON_BYTES = 64*1024*1024;
export const emptyResourceMetadata = ():ResourceMetadata=>({status:"none",title:"",description:"",fetchedAt:null});
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const date=(value:unknown):value is string=>typeof value==="string"&&Number.isFinite(Date.parse(value));
const uuid=(value:unknown):value is string=>typeof value==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const id=(value:unknown):value is string=>typeof value==="string"&&/^[a-zA-Z0-9_-]{1,100}$/.test(value);
function text(value:unknown,max:number,label:string):string {
  if(typeof value!=="string"||value.length>max)throw new Error(label+"を確認してください。");
  jsonbByteLength(value);return value;
}
export function resourceUrl(value:unknown,optional=false):string|null {
  if(optional&&(value===null||value===""))return null;
  if(typeof value!=="string"||value.length>8192)throw new Error("URLを確認してください。");
  try {
    const url=new URL(value.trim());
    if(!["http:","https:"].includes(url.protocol)||url.username||url.password||!url.hostname)throw new Error();
    jsonbByteLength(value);return url.toString();
  }catch{throw new Error("http または https のURLを入力してください。");}
}
export function canonicalResourceUrl(value:string):string {
  const url=new URL(resourceUrl(value)!);url.hash="";return url.toString();
}
export function parseResourceImage(value:unknown):ResourceImage {
  if(!object(value)||typeof value.sha256!=="string"||!/^[0-9a-f]{64}$/.test(value.sha256)||
    !["image/png","image/jpeg","image/gif","image/webp"].includes(String(value.mimeType))||
    !Number.isSafeInteger(value.size)||Number(value.size)<8||Number(value.size)>MAX_RESOURCE_FILE_BYTES)
    throw new Error("画像の原本情報を確認してください。");
  const filename=text(value.filename,255,"ファイル名");
  if(!filename.trim())throw new Error("ファイル名を確認してください。");
  return {sha256:value.sha256,mimeType:value.mimeType as ResourceMime,size:Number(value.size),filename};
}
export function parseResourceSpaces(value:unknown):string[] {
  if(!Array.isArray(value)||!Array.from(value).every(id))throw new Error("スペースを確認してください。");
  const result=[...new Set(value as string[])];if(result.length>1000)throw new Error("スペースは1,000個まで設定できます。");return result;
}
export function parseResourceMetadata(value:unknown):ResourceMetadata {
  if(!object(value)||!["none","pending","ready","failed"].includes(String(value.status))||!(value.fetchedAt===null||date(value.fetchedAt)))
    throw new Error("取得情報を確認してください。");
  return {status:value.status as ResourceMetadata["status"],title:text(value.title,300,"取得タイトル"),description:text(value.description,2000,"取得説明"),fetchedAt:value.fetchedAt as string|null};
}
export function parseResource(value:unknown):Resource {
  if(!object(value)||!uuid(value.id)||value.kind!=="resource"||value.originApp!=="collect"||
    !["link","image"].includes(String(value.resourceType))||!(value.ownerId===null||uuid(value.ownerId))||
    typeof value.inbox!=="boolean"||typeof value.pinned!=="boolean"||!date(value.createdAt)||!date(value.updatedAt)||
    !(value.deletedAt===null||date(value.deletedAt))||!Number.isSafeInteger(value.localRevision)||Number(value.localRevision)<1||
    !(value.serverRevision===null||(Number.isSafeInteger(value.serverRevision)&&Number(value.serverRevision)>0)))
    throw new Error("収集した資料のデータを確認してください。");
  const resource:Resource={
    id:value.id,kind:"resource",originApp:"collect",ownerId:value.ownerId as string|null,resourceType:value.resourceType as Resource["resourceType"],
    url:resourceUrl(value.url,value.resourceType==="image"),sourceUrl:resourceUrl(value.sourceUrl,true),
    title:text(value.title,300,"タイトル"),memo:text(value.memo,100000,"メモ"),spaceIds:parseResourceSpaces(value.spaceIds),
    inbox:value.inbox,pinned:value.pinned,image:value.image===null?null:parseResourceImage(value.image),
    metadata:parseResourceMetadata(value.metadata),createdAt:value.createdAt,updatedAt:value.updatedAt,deletedAt:value.deletedAt as string|null,
    localRevision:Number(value.localRevision),serverRevision:value.serverRevision as number|null,
  };
  if((resource.resourceType==="image")!==(resource.image!==null))throw new Error("資料の種類と原本を確認してください。");
  assertResourceSyncBudget(resource);return resource;
}
export function assertResourceSyncBudget(resource:Resource):void {
  const id="00000000-0000-4000-8000-000000000000";
  if(jsonbByteLength({id,kind:"put_resource",entityId:resource.id,baseRevision:Number.MAX_SAFE_INTEGER,previousOperationId:id,
    createdAt:"9999-12-31T23:59:59.999Z",payload:{...resource,ownerId:id,localRevision:Number.MAX_SAFE_INTEGER,serverRevision:Number.MAX_SAFE_INTEGER}})>1048576)
    throw new Error("資料のデータが大きすぎます。メモを分けてください。");
}
export function parseCollectDraft(value:unknown):CollectDraft {
  if(!object(value)||!["link","image"].includes(String(value.resourceType))||typeof value.inbox!=="boolean")throw new Error("下書きを確認してください。");
  const draft:CollectDraft={resourceType:value.resourceType as CollectDraft["resourceType"],url:text(value.url,8192,"URL"),sourceUrl:text(value.sourceUrl,8192,"出典URL"),
    title:text(value.title,300,"タイトル"),memo:text(value.memo,100000,"メモ"),spaceIds:parseResourceSpaces(value.spaceIds),inbox:value.inbox,
    image:value.image===null?null:parseResourceImage(value.image)};
  if(value.editingId!==undefined){if(!uuid(value.editingId))throw new Error("編集先を確認してください。");draft.editingId=value.editingId;}
  if(value.expectedRevision!==undefined){if(!Number.isSafeInteger(value.expectedRevision)||Number(value.expectedRevision)<1)throw new Error("編集番号を確認してください。");draft.expectedRevision=Number(value.expectedRevision);}
  return draft;
}
export function parseCollectBackup(value:unknown):CollectBackup {
  if(!object(value)||value.format!=="personal-tools.collect"||value.version!==1||!date(value.exportedAt)||
    !Array.isArray(value.resources)||value.resources.length>10000||!Array.isArray(value.spaces)||value.spaces.length>10000||!Array.isArray(value.files)||value.files.length>10000)
    throw new Error("Collectのバックアップ形式を確認してください。");
  if(new TextEncoder().encode(JSON.stringify(value)).byteLength>MAX_COLLECT_BACKUP_JSON_BYTES)
    throw new Error("バックアップが64MBを超えています。分けて読み込んでください。");
  const spaceIds=new Set<string>();
  const spaces:Space[]=value.spaces.map((space:unknown)=>{
    if(!object(space)||!id(space.id)||spaceIds.has(space.id)||typeof space.name!=="string"||!space.name.trim()||space.name.length>40||
      typeof space.color!=="string"||!/^#[0-9a-f]{6}$/i.test(space.color)||!date(space.createdAt))throw new Error("スペースを確認してください。");
    spaceIds.add(space.id);jsonbByteLength(space.name);return {id:space.id,name:space.name,color:space.color,createdAt:space.createdAt};
  });
  const resourceIds=new Set<string>();
  const resources=value.resources.map((input:unknown)=>{
    const resource=parseResource(input);
    if(resource.ownerId!==null||resource.serverRevision!==null||resourceIds.has(resource.id)||!resource.spaceIds.every(id=>spaceIds.has(id)))
      throw new Error("持ち運び用の資料バックアップを選んでください。");
    resourceIds.add(resource.id);return resource;
  });
  const fileIds=new Set<string>();let total=0;
  const files=value.files.map((input:unknown)=>{
    const image=parseResourceImage(input);
    if(!object(input)||typeof input.data!=="string"||fileIds.has(image.sha256)||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)||
      input.data.length!==4*Math.ceil(image.size/3))throw new Error("画像のバックアップを確認してください。");
    const decodedSize=input.data.length/4*3-(input.data.endsWith("==")?2:input.data.endsWith("=")?1:0);
    if(decodedSize!==image.size)throw new Error("画像のサイズが一致しません。");
    total+=image.size;if(total>MAX_COLLECT_BACKUP_BYTES)throw new Error("画像の合計が32MBを超えています。分けて読み込んでください。");
    fileIds.add(image.sha256);return {...image,data:input.data};
  });
  const fileMap=new Map(files.map(file=>[file.sha256,file]));
  for(const resource of resources)if(resource.image){const file=fileMap.get(resource.image.sha256);if(!file||file.size!==resource.image.size||file.mimeType!==resource.image.mimeType)throw new Error("原本の画像が不足しています。");}
  return {format:"personal-tools.collect",version:1,exportedAt:value.exportedAt,resources,spaces,files};
}
