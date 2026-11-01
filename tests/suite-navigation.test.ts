import test from "node:test";
import assert from "node:assert/strict";
import {createDraftNavigation} from "../packages/ui/src/navigation.ts";

test("Suite navigation: wait for the latest draft commit and reject duplicate clicks",async()=>{
  let finish!:(value:boolean)=>void;const draft=new Promise<boolean>(resolve=>finish=resolve),events:string[]=[];
  const navigate=createDraftNavigation({blocked:()=>false,prepare:()=>{events.push("saving");return draft;},commit:href=>events.push(href),failure:()=>assert.fail("Unexpected failure"),pending:value=>events.push(String(value))});
  const first=navigate("/atlas/");assert.deepEqual(events,["true","saving"]);
  assert.equal(await navigate("/collect/"),false);finish(true);assert.equal(await first,true);
  assert.deepEqual(events,["true","saving","/atlas/","false"]);
});
test("Suite navigation: a failed save keeps the screen open and allows retry",async()=>{
  const errors:unknown[]=[],destinations:string[]=[];let full=true;
  const navigate=createDraftNavigation({blocked:()=>false,prepare:async()=>{if(full)throw new DOMException("Full","QuotaExceededError");return true;},commit:href=>destinations.push(href),failure:error=>errors.push(error)});
  assert.equal(await navigate("/recall/"),false);assert.equal(errors.length,1);assert.deepEqual(destinations,[]);
  full=false;assert.equal(await navigate("/recall/"),true);assert.deepEqual(destinations,["/recall/"]);
});
test("Suite navigation: active drawing blocks both the initial click and a deferred save",async()=>{
  let blocked=true,saves=0,finish!:(value:boolean)=>void;
  const navigate=createDraftNavigation({blocked:()=>blocked,prepare:()=>{saves++;return new Promise(resolve=>finish=resolve);},commit:()=>assert.fail("Drawing must remain open"),failure:()=>assert.fail("Unexpected failure")});
  assert.equal(await navigate("/atlas/"),false);assert.equal(saves,0);
  blocked=false;const pending=navigate("/atlas/");blocked=true;finish(true);assert.equal(await pending,false);
});
test("Suite navigation: an invalidated account/repository cannot complete a deferred navigation",async()=>{
  let current=true,finish!:()=>void;
  const wait=new Promise<void>(resolve=>finish=resolve);
  const navigate=createDraftNavigation({blocked:()=>false,prepare:async()=>{await wait;return current;},commit:()=>assert.fail("Scope changed"),failure:()=>assert.fail("Unexpected failure")});
  const pending=navigate("/sketchbook/");current=false;finish();assert.equal(await pending,false);
});
