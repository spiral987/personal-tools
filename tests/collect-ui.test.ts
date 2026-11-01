import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {ConflictError,openRecallRepository,prepareResourceImage} from "../packages/api-client/src/index.ts";
import {blankCapture,captureFingerprint,draftFor,initialCapture,mergeShareCapture,readShareCapture,rebaseMetadataDraft,safeLink,withoutShareParams} from "../apps/collect/app/capture.ts";
import {saveCaptureResource} from "../apps/collect/app/draft-save.ts";
import {clipboardImage} from "../apps/collect/app/clipboard.ts";
import {imageCaptureFields} from "../apps/collect/app/capture.ts";

test("Collect image input: a link URL becomes the source without discarding a distinct existing source",()=>{
  const draft={...blankCapture(),url:"https://example.test/article",title:"残す題",memo:"残す本文",spaceIds:["research"]},before=structuredClone(draft);
  assert.deepEqual(imageCaptureFields(draft),{resourceType:"image",url:"",sourceUrl:draft.url});
  assert.deepEqual(draft,before);
  assert.throws(()=>imageCaptureFields({...draft,sourceUrl:"https://example.test/original"}),/両方を残す/);
});

test("Collect clipboard: text stays native, file lists are not duplicated, and multiple images require separate pastes",()=>{
  const file=new File(["image"],"pasted.png",{type:"image/png"});
  const data=(items:unknown[],files:File[]=[])=>({items,files}) as unknown as Pick<DataTransfer,"items"|"files">;
  assert.equal(clipboardImage(data([{kind:"string",type:"text/plain"}],[])),null);
  assert.equal(clipboardImage(data([{kind:"file",type:"image/png",getAsFile:()=>file}],[file])),file);
  assert.equal(clipboardImage(data([],[file])),file);
  assert.equal(clipboardImage(data([{kind:"file",type:"image/png",getAsFile:()=>null}])),null);
  assert.throws(()=>clipboardImage(data([],[file,file])),/1枚ずつ/);
});

const databaseName=()=>`collect-ui-${crypto.randomUUID()}`;
const gif=()=>new Blob([Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==","base64")],{type:"image/gif"});

test("Collect UI: an unsaved image draft and original survive reopening and take priority over an item link",async t=>{
  const name=databaseName(),repo=await openRecallRepository(name);
  const saved=await repo.saveResource({...blankCapture(),url:"https://example.test/saved"});
  const blob=gif(),image=await prepareResourceImage(blob,"original.gif"),draft={...blankCapture(),resourceType:"image" as const,image,memo:"下書きのメモ"};
  await repo.saveCollectDraft(draft,blob);repo.close();
  const reopened=await openRecallRepository(name);t.after(()=>reopened.close());
  const recovered=await reopened.loadCollectDraft(),initial=initialCapture(recovered,(await reopened.snapshot()).resources,saved.id);
  assert.equal(initial.restored,true);assert.equal(initial.restoreFile,true);assert.deepEqual(initial.draft,draft);
  assert.deepEqual(await (await reopened.getCollectDraftFile())!.arrayBuffer(),await blob.arrayBuffer());
});

test("Collect UI: opening a different item never attaches the previous draft's original",async t=>{
  const repo=await openRecallRepository(databaseName());t.after(()=>repo.close());
  const image=await prepareResourceImage(gif(),"original.gif"),first=await repo.saveResource({...blankCapture(),resourceType:"image",image,file:gif()});
  const other={...first,id:crypto.randomUUID(),image:{...image,sha256:"a".repeat(64)}};
  const initial=initialCapture(draftFor(first),[first,other],other.id);
  assert.equal(initial.restored,false);assert.equal(initial.draft.editingId,other.id);assert.equal(initial.restoreFile,false);
});

test("Collect UI: share GET remains a proposal and only explicit merge appends without replacing a draft",()=>{
  const draft={...blankCapture(),title:"手入力のタイトル",url:"https://example.test/own",sourceUrl:"https://example.test/source",memo:"手入力のメモ",spaceIds:["research"]};
  const before=structuredClone(draft),proposal=readShareCapture("?url=https%3A%2F%2Fexample.test%2Fshared&title=Shared&text=From+the+share");
  assert.deepEqual(draft,before);assert.ok(proposal);
  const next=mergeShareCapture(draft,proposal);
  assert.equal(next.title,before.title);assert.equal(next.url,before.url);assert.equal(next.sourceUrl,before.sourceUrl);assert.deepEqual(next.spaceIds,before.spaceIds);
  assert.equal(next.memo,"手入力のメモ\n\nShared\n\nFrom the share\n\nhttps://example.test/shared");assert.deepEqual(draft,before);
  assert.equal(readShareCapture("?item=123"),null);assert.equal(readShareCapture("?url=javascript%3Aalert(1)")?.url,"");assert.equal(safeLink("https://name:password@example.test"),undefined);
});

test("Collect UI: share merge keeps image identity, refuses overflowing memo, and URL cleanup preserves navigation",()=>{
  const draft={...blankCapture(),resourceType:"image" as const,image:{sha256:"b".repeat(64),filename:"original.png",mimeType:"image/png" as const,size:50},editingId:crypto.randomUUID(),expectedRevision:4};
  const next=mergeShareCapture(draft,{title:"Shared",memo:"Context",url:"https://example.test/"});
  assert.deepEqual(next.image,draft.image);assert.equal(next.url,"");assert.equal(next.expectedRevision,4);assert.match(next.memo,/https:\/\/example.test\//);
  assert.throws(()=>mergeShareCapture({...draft,memo:"m".repeat(100000)},{title:"",memo:"extra",url:""}),/長すぎます/);
  assert.equal(withoutShareParams("https://example.test/collect/?item=kept&url=private&title=private&text=private&filter=kept#composer"),"/collect/?item=kept&filter=kept#composer");
});

test("Collect UI: metadata revision rebasing preserves manual edits and refuses actual content changes",async t=>{
  const repo=await openRecallRepository(databaseName());t.after(()=>repo.close());
  const baseline=await repo.saveResource({...blankCapture(),url:"https://example.test/",title:"保存した題",memo:"保存したメモ"});
  const draft={...draftFor(baseline),title:"書きかけの題",memo:"書きかけのメモ"},fingerprint=captureFingerprint(draft);
  const job=await repo.startResourceMetadata(baseline.id,baseline.localRevision),latest=await repo.finishResourceMetadata(baseline.id,job.token,{title:"Web title",description:"Web description"});assert.ok(latest);
  const rebased=rebaseMetadataDraft(draft,baseline,latest);assert.ok(rebased);assert.equal(rebased.expectedRevision,latest.localRevision);assert.equal(captureFingerprint(rebased),fingerprint);
  for(const changed of [{...latest,memo:"別の編集"},{...latest,url:"https://example.test/changed"},{...latest,deletedAt:new Date().toISOString()},{...latest,pinned:true}])assert.equal(rebaseMetadataDraft(draft,baseline,changed),null);
});

test("Collect UI: JSONB image key order does not mark unchanged content dirty or block sync rebasing",async t=>{
  const repo=await openRecallRepository(databaseName());t.after(()=>repo.close());
  const image=await prepareResourceImage(gif(),"original.gif"),baseline=await repo.saveResource({...blankCapture(),resourceType:"image",image,file:gif(),memo:"保存したメモ"});
  const latest={...baseline,localRevision:baseline.localRevision+1,serverRevision:1,image:{size:image.size,filename:image.filename,mimeType:image.mimeType,sha256:image.sha256}};
  assert.notEqual(JSON.stringify(baseline.image),JSON.stringify(latest.image));
  assert.equal(captureFingerprint(draftFor(baseline)),captureFingerprint(draftFor(latest)));
  const draft={...draftFor(baseline),memo:"入力中のメモ"},rebased=rebaseMetadataDraft(draft,baseline,latest);
  assert.ok(rebased);assert.equal(rebased.expectedRevision,latest.localRevision);assert.equal(rebased.memo,draft.memo);
  for(const changed of [{...latest,image:{...latest.image,sha256:"a".repeat(64)}},{...latest,image:{...latest.image,filename:"different.gif"}}])assert.equal(rebaseMetadataDraft(draft,baseline,changed),null);
});

test("Collect UI: a metadata completion racing Save retries safely and preserves manual title/memo",async t=>{
  const repo=await openRecallRepository(databaseName());t.after(()=>repo.close());
  const baseline=await repo.saveResource({...blankCapture(),url:"https://example.test/"}),draft={...draftFor(baseline),title:"自分の題",memo:"自分のメモ"};let saves=0;
  const saved=await saveCaptureResource({snapshot:()=>repo.snapshot(),saveResource:async(input,expected)=>{
    if(++saves===1){const job=await repo.startResourceMetadata(baseline.id,baseline.localRevision);await repo.finishResourceMetadata(baseline.id,job.token,{title:"Fetched title",description:"Fetched description"});}
    return repo.saveResource(input,expected);
  }},draft,null,baseline,()=>true);
  assert.equal(saves,2);assert.ok(saved);assert.equal(saved.title,draft.title);assert.equal(saved.memo,draft.memo);assert.equal(saved.metadata.title,"Fetched title");
});

test("Collect UI: a competing manual edit is surfaced without overwrite or duplicate creation",async t=>{
  const repo=await openRecallRepository(databaseName());t.after(()=>repo.close());
  const baseline=await repo.saveResource({...blankCapture(),url:"https://example.test/"});
  await repo.updateResource(baseline.id,{memo:"別の画面のメモ"},baseline.localRevision);
  await assert.rejects(saveCaptureResource(repo,{...draftFor(baseline),memo:"手元のメモ"},null,baseline,()=>true),ConflictError);
  const data=await repo.snapshot();assert.equal(data.resources.length,1);assert.equal(data.resources[0].memo,"別の画面のメモ");
});

test("Collect UI: invalidated account scope cannot retry a save after an awaited snapshot",async t=>{
  const repo=await openRecallRepository(databaseName());t.after(()=>repo.close());
  const baseline=await repo.saveResource({...blankCapture(),url:"https://example.test/"});let current=true,saves=0;
  const result=await saveCaptureResource({snapshot:async()=>{const data=await repo.snapshot();current=false;return data;},saveResource:async()=>{saves++;throw new ConflictError();}},draftFor(baseline),null,baseline,()=>current);
  assert.equal(result,null);assert.equal(saves,1);
  assert.equal(await saveCaptureResource({snapshot:()=>repo.snapshot(),saveResource:async()=>{throw new Error("Must not write");}},draftFor(baseline),null,baseline,()=>false),null);
});
