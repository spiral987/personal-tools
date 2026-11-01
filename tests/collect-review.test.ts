import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import {test} from "node:test";
import {parseCollectBackup} from "../packages/core/src/collect.ts";
import {openRecallRepository} from "../packages/api-client/src/repository.ts";
import {prepareResourceFile,prepareResourceImage} from "../packages/api-client/src/resource-files.ts";

const base={resourceType:"file" as const,url:"",sourceUrl:"",title:"",memo:"",spaceIds:[],inbox:true,image:null};
async function mixedMimePair(repo:Awaited<ReturnType<typeof openRecallRepository>>){
  const plain=new Blob(["same original bytes"],{type:"text/plain"});
  const markdown=new Blob(["same original bytes"],{type:"text/markdown"});
  const a=await repo.saveResource({...base,original:await prepareResourceFile(plain,"a.txt"),file:plain});
  const b=await repo.saveResource({...base,original:await prepareResourceFile(markdown,"b.md"),file:markdown});
  return {a,b};
}

test("F review: shared original bytes retain each resource's declared MIME type",async t=>{
  const repo=await openRecallRepository(`collect-review-${crypto.randomUUID()}`);t.after(()=>repo.close());
  const {a,b}=await mixedMimePair(repo);
  assert.equal((await repo.getResourceFile(a.id))!.type,"text/plain");
  assert.equal((await repo.getResourceFile(b.id))!.type,"text/markdown");
});

test("F review: full backup restores identical bytes with different per-resource MIME types",async t=>{
  const source=await openRecallRepository(`collect-review-${crypto.randomUUID()}`),target=await openRecallRepository(`collect-review-${crypto.randomUUID()}`);
  t.after(()=>source.close());t.after(()=>target.close());await mixedMimePair(source);
  const backup=await source.exportCollectBackup();
  assert.equal(parseCollectBackup(backup).resources.length,2);
  await target.importCollectBackup(backup);
  for(const resource of (await target.snapshot()).resources){
    const blob=(await target.getResourceFile(resource.id))!;
    assert.equal(blob.type,resource.original!.mimeType);
    assert.equal(await blob.text(),"same original bytes");
  }
});

test("F review: a generic carrier does not change or bypass the validation of an image sharing its bytes",async t=>{
  const source=await openRecallRepository(`collect-review-${crypto.randomUUID()}`),target=await openRecallRepository(`collect-review-${crypto.randomUUID()}`);
  t.after(()=>source.close());t.after(()=>target.close());
  const bytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=","base64");
  const generic=new Blob([bytes],{type:"application/octet-stream"}),png=new Blob([bytes],{type:"image/png"});
  await source.saveResource({...base,original:await prepareResourceFile(generic,"copy.bin"),file:generic});
  await source.saveResource({...base,resourceType:"image",image:await prepareResourceImage(png,"image.png"),file:png});
  const backup=await source.exportCollectBackup();assert.equal(backup.files.length,1);
  backup.files[0]={...backup.files[0],mimeType:"application/octet-stream",filename:"copy.bin"};
  await target.importCollectBackup(backup);
  const restored=(await target.snapshot()).resources.find(resource=>resource.resourceType==="image")!;
  assert.equal((await target.getResourceFile(restored.id))!.type,"image/png");
  const corruptImage=structuredClone(backup);const image=corruptImage.resources.find(resource=>resource.resourceType==="image")!;
  image.image={...image.image!,mimeType:"image/jpeg"};
  await assert.rejects(target.importCollectBackup(corruptImage),/一致|種類|確認/);
});
