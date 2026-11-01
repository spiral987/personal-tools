import {resourceOriginal,type CollectDraft,type Resource} from "@personal-tools/core";

/** Only the portable source goes to Drive; private annotations never enter it. */
export function driveDocument(resource:CollectDraft|Resource){
  return new Blob([resource.resourceType==="text"?resource.text??"":`${resource.url??""}\n${resource.sourceUrl&&resource.sourceUrl!==resource.url?`\n出典: ${resource.sourceUrl}\n`:""}`],{type:"text/markdown"});
}
export function driveOriginalSummary(resource:CollectDraft|Resource){
  const original=resourceOriginal(resource);
  return {name:original?.filename??`${resource.title.trim().slice(0,80)||"collect"}.md`,size:original?.size??driveDocument(resource).size};
}
