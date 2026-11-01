import type {CollectDraft,Resource} from "@personal-tools/core";
import {ConflictError,type RecallRepository} from "@personal-tools/api-client";
import {rebaseMetadataDraft} from "./capture.ts";

/** Retry only when a background update left all saved content unchanged. */
export async function saveCaptureResource(repo:Pick<RecallRepository,"saveResource"|"snapshot">,draft:CollectDraft,file:Blob|null,baseline:Resource|undefined,isCurrent:()=>boolean,newId?:string):Promise<Resource|null>{
  let candidate=structuredClone(draft),previous=baseline;
  for(let attempt=0;attempt<3;attempt++){
    if(!isCurrent())return null;
    try{return await repo.saveResource({...candidate,id:candidate.editingId,file:file??undefined,...(newId?{newId}:{})},candidate.expectedRevision);}
    catch(value){
      if(!isCurrent())return null;
      if(!(value instanceof ConflictError)||!previous||!candidate.editingId||attempt===2)throw value;
      const snapshot=await repo.snapshot();if(!isCurrent())return null;
      const latest=snapshot.resources.find(resource=>resource.id===candidate.editingId);
      const rebased=latest?rebaseMetadataDraft(candidate,previous,latest):null;
      if(!rebased)throw value;
      candidate=rebased;previous=latest;
    }
  }
  return null;
}
