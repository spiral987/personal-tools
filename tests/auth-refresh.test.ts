import test from "node:test";
import assert from "node:assert/strict";
import {createSharedSessionRefresh} from "../packages/auth/src/session-refresh.ts";
type Session={user:{id:string}};
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));

test("別タブのログインで共有ロックが解除され、SDK callback外で新しいcookieのsessionを読む",async()=>{
  let lock:string|null="1",reads=0;
  const queue:(()=>void)[]=[],applied:(Session|null)[]=[];
  const boundary=createSharedSessionRefresh<Session>({readLock:()=>lock,readSession:async()=>{reads++;return {user:{id:"signed-in-in-another-tab"}};},applySession:session=>applied.push(session),schedule:work=>{queue.push(work);}});
  assert.equal(boundary.isBlocked(),true);
  lock="0";boundary.request();
  assert.equal(reads,0,"SDK calls must be deferred until after the auth callback returns");
  queue.shift()!();await flush();
  assert.equal(boundary.isBlocked(),false);assert.equal(reads,1);assert.equal(applied[0]?.user.id,"signed-in-in-another-tab");
});
test("オフラインでログアウトしたままのタブは古いsessionを読み直さない",async()=>{
  let lock:string|null="1",reads=0;const queue:(()=>void)[]=[];
  const boundary=createSharedSessionRefresh<Session>({readLock:()=>lock,readSession:async()=>{reads++;return {user:{id:"old-user"}};},applySession:()=>assert.fail("locked account must not reopen"),schedule:work=>{queue.push(work);}});
  boundary.request();assert.equal(queue.length,0);assert.equal(reads,0);
  lock=null;assert.equal(boundary.isBlocked(),true,"storage failure/clear must not unlock an offline logout");
  boundary.request();await flush();assert.equal(reads,0);
});
test("新しいsession取得中にログアウトした場合、遅れて返った情報でアカウントを開かない",async()=>{
  let lock:string|null="0",resolveSession!:(session:Session)=>void;
  const queue:(()=>void)[]=[],applied:unknown[]=[];
  const pending=new Promise<Session>(resolve=>{resolveSession=resolve;});
  const boundary=createSharedSessionRefresh<Session>({readLock:()=>lock,readSession:()=>pending,applySession:session=>applied.push(session),schedule:work=>{queue.push(work);}});
  boundary.request();queue.shift()!();await flush();
  lock="1";boundary.block();resolveSession({user:{id:"late-user"}});await flush();
  assert.equal(applied.length,0);assert.equal(boundary.isBlocked(),true);
});
test("アンマウント・切替後の予約済みSDK呼び出しを捨てる",async()=>{
  let reads=0;const queue:(()=>void)[]=[];
  const boundary=createSharedSessionRefresh<Session>({readLock:()=>"0",readSession:async()=>{reads++;return null;},applySession:()=>assert.fail("stopped boundary must not apply"),schedule:work=>{queue.push(work);}});
  boundary.request();boundary.stop();queue.shift()!();await flush();assert.equal(reads,0);
});
