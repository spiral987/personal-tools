import {normalizeText, noteTitle, type Note, type Sketch, type ItemRelation, type RelationType} from "./index.ts";
import type {Resource} from "./collect.ts";

export type AtlasItem = Note | Sketch | Resource;
type AtlasVersion = {id:string;ownerId:string|null;createdAt:string;updatedAt:string;deletedAt:string|null;localRevision:number;serverRevision:number|null};
export type AtlasProject = AtlasVersion & {kind:"project";name:string;description:string;status:"active"|"paused"|"done";dueDate:string|null;itemIds:string[]};
/** Only human-confirmed labels live here. Reanalysis never mutates this record. */
export type ItemLabels = AtlasVersion & {kind:"labels";tags:string[]};
export const RELATION_TYPES:RelationType[]=["inspired_by","elaborates","supports","contradicts","related_to"];
export const RELATION_NAMES:Record<RelationType,[string,string]>={inspired_by:["着想を得た","この記録に着想を得た"],elaborates:["詳しく展開した","この記録を展開した"],supports:["根拠にしている","この記録を根拠にした"],contradicts:["異なる見方を示す","異なる見方がある"],related_to:["関連する","関連する"]};
const id=(v:unknown):v is string=>typeof v==="string"&&/^[a-zA-Z0-9_-]{1,100}$/.test(v);
export function parseTags(value:unknown):string[]{
  if(!Array.isArray(value)||value.length>50||!value.every(v=>typeof v==="string"&&v.trim()&&v.length<=40))throw new Error("タグは40文字以内、50個までで入力してください。");
  return [...new Map(value.map((v:string)=>[normalizeText(v),v.trim()])).values()];
}
export function parseProjectFields(value:unknown):Pick<AtlasProject,"name"|"description"|"status"|"dueDate"|"itemIds">{
  const v=value as AtlasProject;
  if(!v||typeof v!=="object"||typeof v.name!=="string"||!v.name.trim()||v.name.length>120||typeof v.description!=="string"||v.description.length>10000||!["active","paused","done"].includes(v.status)||
    !(v.dueDate===null||typeof v.dueDate==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(v.dueDate)&&Number.isFinite(Date.parse(v.dueDate))&&new Date(v.dueDate).toISOString().slice(0,10)===v.dueDate)||!Array.isArray(v.itemIds)||v.itemIds.length>1000||!v.itemIds.every(id))throw new Error("プロジェクトの名前・状態・期日・所属を確認してください。");
  return {name:v.name.trim(),description:v.description,status:v.status,dueDate:v.dueDate,itemIds:[...new Set(v.itemIds)]};
}
export function atlasTitle(item:AtlasItem){return item.kind==="note"?noteTitle(item.body):item.title||(item.kind==="resource"?(item.image?.filename||item.url):"無題のスケッチ")||"無題の資料";}
export function atlasText(item:AtlasItem){return item.kind==="note"?item.body:item.kind==="resource"?[item.title,item.memo,item.url,item.sourceUrl,item.metadata.title,item.metadata.description,item.image?.filename].filter(Boolean).join("\n"):item.title;}
export function originalHref(item:AtlasItem){return `/${item.originApp}/?item=${encodeURIComponent(item.id)}`;}
export type AtlasFilter={query?:string;kind?:string;spaceId?:string;tag?:string;projectId?:string;pinned?:boolean};
export function searchAtlas(items:AtlasItem[],labels:ItemLabels[],projects:AtlasProject[],filter:AtlasFilter,ownerId:string|null):AtlasItem[]{
  const tags=new Map(labels.filter(l=>l.ownerId===ownerId&&!l.deletedAt).map(l=>[l.id,l.tags]));
  const project=filter.projectId?projects.find(p=>p.id===filter.projectId&&p.ownerId===ownerId&&!p.deletedAt):null;
  const words=normalizeText(filter.query??"").split(/\s+/u).filter(Boolean);
  return items.filter(item=>item.ownerId===ownerId&&!item.deletedAt&&(!filter.kind||item.kind===filter.kind)&&(!filter.spaceId||item.spaceIds.includes(filter.spaceId))&&(!filter.pinned||item.pinned)&&
    (!filter.projectId||!!project?.itemIds.includes(item.id))&&(!filter.tag||(tags.get(item.id)??[]).some(t=>normalizeText(t)===normalizeText(filter.tag??"")))&&
    words.every(word=>normalizeText(atlasText(item)+"\n"+(tags.get(item.id)??[]).join(" ")).includes(word))).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
}
export function relatedItems(item:AtlasItem,items:AtlasItem[],relations:ItemRelation[]){
  const active=new Map(items.filter(i=>i.ownerId===item.ownerId&&!i.deletedAt).map(i=>[i.id,i]));
  return relations.filter(r=>r.ownerId===item.ownerId&&!r.deletedAt&&(r.fromItemId===item.id||r.toItemId===item.id)).flatMap(relation=>{
    const forward=relation.fromItemId===item.id,other=active.get(forward?relation.toItemId:relation.fromItemId);
    return other?[{relation,item:other,label:RELATION_NAMES[relation.type][forward?0:1]}]:[];
  });
}
