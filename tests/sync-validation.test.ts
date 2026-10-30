import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {createSupabaseSyncTransport,createSyncEngine,openAccountRecallRepository} from "../packages/api-client/src/index.ts";
import type {Note,Space,SyncPullResult} from "../packages/core/src/index.ts";
const user="33333333-3333-4333-8333-333333333333";
const now=new Date().toISOString();
const note:Note={id:crypto.randomUUID(),kind:"note",originApp:"recall",ownerId:user,body:"本人の本文",spaceIds:[],pinned:false,createdAt:now,updatedAt:now,deletedAt:null,localRevision:1,serverRevision:1};
const space:Space={id:"daily",name:"日常",color:"#729379",ownerId:user,createdAt:now,localRevision:1,serverRevision:1};
const adapter=(data:unknown)=>createSupabaseSyncTransport({async rpc(){return {data,error:null};}},user);
test("RPCは種類違い・壊れた日時・逆行cursorを拒否する",async()=>{
  const good:SyncPullResult={changes:[{cursor:"1",entity:"note",record:note}],cursor:"1",hasMore:false};
  assert.equal((await adapter(good).pull("0",100)).changes.length,1);
  for(const bad of [
    {...good,changes:[{cursor:"1",entity:"space",record:note}]},
    {...good,changes:[{cursor:"1",entity:"note",record:{...note,createdAt:"not a date"}}]},
    {...good,changes:[{cursor:"2",entity:"note",record:note},{cursor:"1",entity:"space",record:space}],cursor:"1"},
    {...good,cursor:"100"},
    {changes:[],cursor:"0",hasMore:true},
  ])await assert.rejects(adapter(bad).pull("0",100));
  await assert.rejects(adapter({status:"applied",operationId:"op",record:space}).push({id:"op",kind:"put_note",entityId:note.id,baseRevision:null,payload:note,createdAt:now}),/項目/);
});
test("SQL例外と任意のtransport例外を画面用statusに露出しない",async()=>{
  const secret="SQL private body: never disclose this in error";
  const rpc=createSupabaseSyncTransport({async rpc(){return {data:null,error:{message:secret,code:"P0001"}};}},user);
  await assert.rejects(rpc.pull("0",100),error=>error instanceof Error&&!error.message.includes(secret));
  const repo=await openAccountRecallRepository(user,{name:`test-${crypto.randomUUID()}`});
  const engine=createSyncEngine(repo,{userId:user,async push(){throw new Error(secret);},async pull(){throw new Error(secret);}});
  const status=await engine.run();assert.equal(status.phase,"error");assert.ok(status.error);assert.equal(status.error.includes(secret),false);assert.ok(status.error.includes("端末のメモは残っています"));engine.stop();repo.close();
});
