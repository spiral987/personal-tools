import type {Sketch,SketchDraft} from "@personal-tools/core";
export const sketchDraftFingerprint=(draft:Pick<SketchDraft,"title"|"strokes"|"spaceIds">)=>JSON.stringify({title:draft.title.trim(),strokes:draft.strokes,spaceIds:[...draft.spaceIds].sort()});
export function shouldRestoreSketchDraft(draft:SketchDraft,saved:Sketch|undefined){
  const meaningful=!!draft.title.trim()||draft.strokes.length>0||draft.spaceIds.length>0||!!draft.sourceNoteId;
  return meaningful&&(!!draft.sourceNoteId||!saved||sketchDraftFingerprint(draft)!==sketchDraftFingerprint(saved));
}
