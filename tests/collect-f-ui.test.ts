import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {blankCapture,captureFingerprint,draftFor,initialCapture,rebaseMetadataDraft,matchesResource} from "../apps/collect/app/capture.ts";
import {driveDocument} from "../apps/collect/app/drive-document.ts";
import {openRecallRepository,prepareResourceFile} from "../packages/api-client/src/index.ts";

test("Collect Drive document exports only portable URL/source or text body, never private annotations",async()=>{
  const link={...blankCapture(),url:"https://example.test/article",sourceUrl:"https://example.test/source",title:"自分の題",memo:"絶対に送らない追記",spaceIds:["private-space"]};
  const content=await driveDocument(link).text();assert.match(content,/https:\/\/example.test\/article/);assert.match(content,/https:\/\/example.test\/source/);
  assert.doesNotMatch(content,/絶対|private-space|自分の題/);
  const text={...link,resourceType:"text" as const,url:"",text:"Driveで読める本文"};assert.equal(await driveDocument(text).text(),text.text);
});

test("Collect generic draft fingerprint normalizes original fields, restores only matching bytes and searches body/filename",async t=>{
  const repo=await openRecallRepository(`collect-f-ui-${crypto.randomUUID()}`);t.after(()=>repo.close());
  const blob=new Blob(["portable file"],{type:"text/plain"}),original=await prepareResourceFile(blob,"調査.txt"),draft={...blankCapture(),resourceType:"file" as const,original};
  await repo.saveCollectDraft(draft,blob);const recovered=await repo.loadCollectDraft();assert.equal(initialCapture(recovered,[],null).restoreFile,true);
  const saved=await repo.saveResource({...draft,file:blob,title:"収集資料"}),other={...saved,id:crypto.randomUUID(),original:{...original,sha256:"a".repeat(64)}};
  const initial=initialCapture(draftFor(saved),[saved,other],other.id);assert.equal(initial.restoreFile,false);
  assert.equal(captureFingerprint(draft),captureFingerprint({...draft,original:{filename:original.filename,size:original.size,mimeType:original.mimeType,sha256:original.sha256}}));
  assert.equal(matchesResource({...saved,text:"青い星について"},"星 調査"),true);
});

test("Collect Drive acknowledgement rebases pending reference without losing user's unsaved memo",async t=>{
  const repo=await openRecallRepository(`collect-f-ui-${crypto.randomUUID()}`);t.after(()=>repo.close());
  const baseline=await repo.saveResource({...blankCapture(),url:"https://example.test/"}),draft={...draftFor(baseline),memo:"いま入力している追記"};
  const drive={fileId:"fixture_file",accountId:"fixture_owner",name:"article.md",mimeType:"text/markdown",size:10,version:"2",modifiedTime:null,status:"ready" as const,checkedAt:new Date().toISOString()};
  const latest={...baseline,drive,localRevision:baseline.localRevision+1};
  const rebased=rebaseMetadataDraft(draft,baseline,latest);assert.ok(rebased);assert.equal(rebased.memo,draft.memo);assert.deepEqual(rebased.drive,drive);assert.equal(rebased.expectedRevision,latest.localRevision);
});
