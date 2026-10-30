import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {matchesQuery,parseBackup} from "../packages/core/src/index.ts";
import {openRecallRepository,ConflictError} from "../packages/api-client/src/index.ts";
const newRepo=()=>openRecallRepository(`test-${crypto.randomUUID()}`);

test("日本語・全角英数字の正規化と複数語AND検索",async()=>{
  const repo=await newRepo();const note=await repo.saveNote({body:"散歩中に考えた ＡＩ のこと",spaceIds:[]});
  assert.equal(matchesQuery(note,"ai 散歩"),true);assert.equal(matchesQuery(note,"散歩 画像"),false);
});
test("保存は別の接続で復元でき、下書きが正式なメモに変わる",async()=>{
  const name=`test-${crypto.randomUUID()}`;const repo=await openRecallRepository(name);
  await repo.saveDraft("散歩の記録",["daily"]);assert.equal((await repo.loadDraft()).body,"散歩の記録");
  await repo.saveNote({body:"散歩の記録",spaceIds:["daily"]});
  const reopened=await openRecallRepository(name);assert.equal((await reopened.snapshot()).notes.length,1);assert.equal((await reopened.loadDraft()).body,"");
  const db=await new Promise<IDBDatabase>((resolve)=>{const r=indexedDB.open(name);r.onsuccess=()=>resolve(r.result);});
  const tx=db.transaction("outbox");const operations=await new Promise<unknown[]>((resolve)=>{const r=tx.objectStore("outbox").getAll();r.onsuccess=()=>resolve(r.result);});
  assert.equal(operations.length,1);db.close();
});
test("古いrevisionの更新を拒否して新しい本文を保持",async()=>{
  const repo=await newRepo();const note=await repo.saveNote({body:"最初",spaceIds:[]});
  await repo.saveNote({...note,body:"別のタブの変更"},note.localRevision);
  await assert.rejects(repo.saveNote({...note,body:"古い画面の変更"},note.localRevision),ConflictError);
  assert.equal((await repo.snapshot()).notes[0].body,"別のタブの変更");
});
test("入力・スペースの検証失敗で下書きを消さない",async()=>{
  const repo=await newRepo();await repo.saveDraft("消えてはいけない",[]);
  await assert.rejects(repo.saveNote({body:"消えてはいけない",spaceIds:["missing"]}));
  assert.equal((await repo.snapshot()).notes.length,0);assert.equal((await repo.loadDraft()).body,"消えてはいけない");
});
test("outbox書き込みの例外時はメモ保存もロールバック",async()=>{
  const repo=await newRepo();const original=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(...args:Parameters<IDBObjectStore["put"]>){
    if(this.name==="outbox")throw new DOMException("test failure","QuotaExceededError");
    return original.apply(this,args);
  };
  try {await assert.rejects(repo.saveNote({body:"途中で失敗",spaceIds:[]}));}
  finally{IDBObjectStore.prototype.put=original;}
  assert.equal((await repo.snapshot()).notes.length,0);
});
test("ごみ箱はバックアップに含まれ、復元できる",async()=>{
  const repo=await newRepo();const note=await repo.saveNote({body:"あとで戻す",spaceIds:["daily"]});
  const deleted=await repo.saveNote({...note,deletedAt:new Date().toISOString()},note.localRevision);
  assert.ok(parseBackup(await repo.exportBackup()).notes[0].deletedAt);
  await repo.saveNote({...deleted,deletedAt:null},deleted.localRevision);assert.equal((await repo.snapshot()).notes[0].deletedAt,null);
});
test("読み込みはIDを再発行し、既存メモとスペース参照を守る",async()=>{
  const repo=await newRepo();const note=await repo.saveNote({body:"原本",spaceIds:["creative"]});const backup=await repo.exportBackup();
  await repo.importBackup(backup);const data=await repo.snapshot();assert.equal(data.notes.length,2);
  assert.ok(data.notes.some(n=>n.id===note.id));const copy=data.notes.find(n=>n.id!==note.id)!;
  assert.notEqual(copy.spaceIds[0],"creative");assert.equal(data.spaces.find(s=>s.id===copy.spaceIds[0])?.name,"創作");
  await assert.rejects(repo.importBackup({...backup,notes:[{...note,spaceIds:["missing"]}]}));
  assert.equal((await repo.snapshot()).notes.length,2);
});
test("ユーザー定義スペースを保存し全角同名の重複を防ぐ",async()=>{
  const repo=await newRepo();const space=await repo.createSpace("旅のこと");assert.equal(space.name,"旅のこと");
  await repo.createSpace("AI");await assert.rejects(repo.createSpace("ＡＩ"));
});
