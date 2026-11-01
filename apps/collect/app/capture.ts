import {resourceOriginal,type CollectDraft,type Resource} from "@personal-tools/core";
export const blankCapture=():CollectDraft=>({resourceType:"link",url:"",sourceUrl:"",title:"",memo:"",spaceIds:[],inbox:true,image:null});
export function imageCaptureFields(draft:CollectDraft):Pick<CollectDraft,"resourceType"|"url"|"sourceUrl">{
  if(draft.url.trim()&&draft.sourceUrl.trim()&&draft.url.trim()!==draft.sourceUrl.trim())throw new Error("URLと出典URLが異なります。両方を残すには、リンクを保存してから新しい収集に画像を追加してください。");
  return {resourceType:"image",url:"",sourceUrl:draft.sourceUrl||draft.url};
}
export const draftFor=(resource:Resource):CollectDraft=>({resourceType:resource.resourceType,url:resource.url??"",sourceUrl:resource.sourceUrl??"",title:resource.title,memo:resource.memo,spaceIds:[...resource.spaceIds],inbox:resource.inbox,image:resource.image,editingId:resource.id,expectedRevision:resource.localRevision,...(resource.original!==undefined?{original:resource.original}:{}),...(resource.text!==undefined?{text:resource.text}:{}),...(resource.drive!==undefined?{drive:resource.drive}:{})});
export function captureFingerprint(draft:CollectDraft):string{const original=resourceOriginal(draft);return JSON.stringify({resourceType:draft.resourceType,url:draft.url.trim(),sourceUrl:draft.sourceUrl.trim(),title:draft.title.trim(),memo:draft.memo,spaceIds:[...draft.spaceIds].sort(),inbox:draft.inbox,text:draft.text??"",original:original?{sha256:original.sha256,mimeType:original.mimeType,size:original.size,filename:original.filename}:null});}
export function sameImageContent(a:CollectDraft["image"],b:CollectDraft["image"]):boolean{return !!a&&!!b&&a.sha256===b.sha256&&a.size===b.size&&a.mimeType===b.mimeType;}
/** A recovered original belongs to its draft, not an unrelated item in the URL. */
export function initialCapture(recovered:CollectDraft,resources:Resource[],requestedId:string|null){
  const saved=resources.find(resource=>resource.id===recovered.editingId),requested=resources.find(resource=>resource.id===requestedId);
  const restored=hasCapture(recovered)&&(!saved||captureFingerprint(recovered)!==captureFingerprint(draftFor(saved)));
  const draft=restored?recovered:requested?draftFor(requested):recovered;
  const a=resourceOriginal(recovered),b=resourceOriginal(draft);
  return {draft,saved:restored?saved:requested??saved,restored,restoreFile:!!a&&!!b&&a.sha256===b.sha256&&a.size===b.size&&a.mimeType===b.mimeType};
}
/** Metadata and sync acknowledgements may advance a revision without changing the person's content. */
export function rebaseMetadataDraft(draft:CollectDraft,baseline:Resource,latest:Resource):CollectDraft|null{
  if(draft.editingId!==baseline.id||latest.id!==baseline.id||draft.expectedRevision!==baseline.localRevision||latest.localRevision<baseline.localRevision)return null;
  const content=(resource:Resource)=>JSON.stringify({capture:captureFingerprint(draftFor(resource)),ownerId:resource.ownerId,createdAt:resource.createdAt,deletedAt:resource.deletedAt,pinned:resource.pinned});
  return content(baseline)===content(latest)?{...draft,expectedRevision:latest.localRevision,...(latest.drive!==undefined?{drive:latest.drive}:{})}:null;
}
export function hasCapture(draft:CollectDraft):boolean{return !!(draft.url.trim()||draft.sourceUrl.trim()||draft.title.trim()||draft.memo.trim()||draft.text?.trim()||resourceOriginal(draft)||draft.spaceIds.length);}
export function displayTitle(resource:Resource):string{return resource.title||resource.metadata.title||resourceOriginal(resource)?.filename||(resource.resourceType==="text"?resource.text?.trim().split("\n")[0]?.slice(0,80):"")||(resource.url?hostname(resource.url):"")||"無題の収集";}
export function hostname(value:string):string{try{return new URL(value).hostname.replace(/^www\./u,"");}catch{return "出典なし";}}
export function safeLink(value:string|null):string|undefined{if(!value)return;try{const url=new URL(value);if(["https:","http:"].includes(url.protocol)&&!url.username&&!url.password)return url.href;}catch{}}
export function matchesResource(resource:Resource,query:string):boolean{const normalize=(value:string)=>value.normalize("NFKC").toLocaleLowerCase("ja");const text=normalize([resource.title,resource.memo,resource.text,resource.url,resource.sourceUrl,resource.metadata.title,resource.metadata.description,resourceOriginal(resource)?.filename,resource.drive?.name].filter(Boolean).join(" "));return normalize(query).trim().split(/\s+/u).filter(Boolean).every(word=>text.includes(word));}
export type ShareCapture={title:string;memo:string;url:string};
/** GET shares are proposals only: preserve the existing draft until the person chooses. */
export function readShareCapture(search:string):ShareCapture|null{
  const params=new URLSearchParams(search);if(!["url","text","title"].some(name=>params.has(name)))return null;
  const title=(params.get("title")??"").slice(0,120),text=(params.get("text")??"").slice(0,10000),rawUrl=(params.get("url")??"").slice(0,8192);
  const fromText=text.match(/https?:\/\/[^\s]+/u)?.[0]??"";
  const candidate=safeLink(rawUrl)||safeLink(fromText)||"";
  return {title,memo:text===candidate?"":text,url:candidate};
}
export function mergeShareCapture(current:CollectDraft,shared:ShareCapture):CollectDraft{
  const parts=[current.memo],url=current.resourceType==="link"&&!current.url?shared.url:current.url;
  if(shared.title&&current.title&&shared.title!==current.title)parts.push(shared.title);
  if(shared.memo)parts.push(shared.memo);
  if(shared.url&&shared.url!==url&&shared.url!==current.sourceUrl)parts.push(shared.url);
  const next={...current,title:current.title||shared.title,url,memo:parts.filter(Boolean).join("\n\n")};
  if(next.memo.length>100000)throw new Error("下書きのメモが長すぎます。先に保存してから共有内容を追加してください。");
  return next;
}
export function withoutShareParams(href:string):string{
  const url=new URL(href);for(const key of ["url","text","title"])url.searchParams.delete(key);
  return url.pathname+url.search+url.hash;
}
export const prettyBytes=(size:number)=>size>=1024*1024?`${(size/1024/1024).toFixed(1)} MB`:`${Math.max(1,Math.round(size/1024))} KB`;
