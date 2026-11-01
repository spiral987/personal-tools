import assert from "node:assert/strict";
import {writeFile} from "node:fs/promises";
import {unlockIfNeeded} from "../tests/browser/vault-ui.mjs";
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??"playwright-core");
const origin="http://127.0.0.1:3190",output="work/atlas-improvement-phase-c-2026-10-31";
const ref="zdixgamfhdgnqbgjckpj",cookie=`sb-${ref}-auth-token`,accountA="11111111-1111-4111-8111-111111111111",accountB="22222222-2222-4222-8222-222222222222";
const browser=await chromium.launch({executablePath:process.env.COLLECT_BROWSER_EXECUTABLE||undefined,headless:true});
const context=await browser.newContext(),results=[],errors=[];
const record=name=>{results.push({name,pass:true});console.log(`${name}: 成功`);};
function session(id){const expires=Math.floor(Date.now()/1000)+3600;const encode=value=>Buffer.from(JSON.stringify(value)).toString("base64url");return {access_token:`${encode({alg:"HS256",typ:"JWT"})}.${encode({sub:id,exp:expires,iat:expires-3600,aud:"authenticated",role:"authenticated"})}.test-signature`,refresh_token:"test-only-refresh-token",token_type:"bearer",expires_in:3600,expires_at:expires,user:{id,aud:"authenticated",role:"authenticated",email:"fixture@example.invalid",app_metadata:{provider:"email"},user_metadata:{},created_at:new Date().toISOString()}};}
async function installSession(id){await context.addCookies([{name:cookie,value:"base64-"+Buffer.from(JSON.stringify(session(id))).toString("base64url"),url:origin,path:undefined,sameSite:"Lax"}]);}
async function cache(page){return page.evaluate(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open("personal-tools-vault-device-v1",1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});try{return await new Promise(resolve=>{const r=db.transaction("session").objectStore("session").get("active");r.onsuccess=()=>resolve(r.result?{scope:r.result.scope}:null);});}finally{db.close();}});}
try{
 await context.addInitScript(()=>sessionStorage.setItem("personal-tools-recall-mode","device"));
 context.on("page",page=>page.on("dialog",dialog=>dialog.accept()));
 const page=await context.newPage();page.on("pageerror",error=>errors.push(String(error)));await page.goto(origin+"/__verify/");await page.waitForResponse(r=>r.url().endsWith("/__verify/results"),{timeout:60000});assert.equal(await page.locator(".fail").count(),0);
 const descriptor=await page.evaluate(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open("personal-tools-vault-config");r.onsuccess=()=>resolve(r.result);});try{return await new Promise(resolve=>{const r=db.transaction("config").objectStore("config").get("descriptor");r.onsuccess=()=>resolve(r.result);});}finally{db.close();}});
 // Mock the service boundary only. Never sign in as or query a real user's data.
 let logoutCount=0;
 await context.route(`https://${ref}.supabase.co/**`,async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==="/rest/v1/vault_keys")return route.fulfill({json:{descriptor}});
  if(url.pathname==="/auth/v1/logout"){logoutCount++;return route.fulfill({status:500,json:{message:"simulated offline logout"}});}
  if(url.pathname==="/auth/v1/user")return route.fulfill({json:session(accountA).user});
  return route.fulfill({status:503,json:{message:"unexpected fixture request"}});
 });
 await installSession(accountA);await page.evaluate(()=>sessionStorage.setItem("personal-tools-recall-mode","device"));await page.goto(origin+"/recall/");await unlockIfNeeded(page);assert.ok((await cache(page)).scope.includes(accountA));
 const peer=await context.newPage();await peer.goto(origin+"/collect/");await unlockIfNeeded(peer);
 await page.getByRole("textbox",{name:"メモの本文",exact:true}).fill("ログアウト直前のメモ");await peer.getByRole("textbox",{name:"自分のメモ",exact:true}).fill("ログアウト直前の資料メモ");
 await page.locator(".pt-settings-button").click();await page.getByRole("button",{name:"このブラウザからログアウト",exact:true}).click();
 for(const p of [page,peer])await p.getByRole("heading",{name:"金庫を解錠",exact:true}).waitFor();await page.waitForFunction(()=>localStorage.getItem("personal-tools-recall-signed-out")==="1");assert.equal(await cache(page),null);
 await unlockIfNeeded(page);assert.equal(await page.getByRole("textbox",{name:"メモの本文",exact:true}).inputValue(),"ログアウト直前のメモ");assert.ok((await cache(page)).scope.endsWith(',"device"]'));record("通信失敗のログアウトでも全タブをロックし、再解錠ではアカウントを開かない");
 await page.locator(".pt-settings-button").click();assert.equal(await page.getByRole("button",{name:"このブラウザからログアウト",exact:true}).count(),0);await page.getByRole("button",{name:"閉じる",exact:true}).click();
 await installSession(accountB);await page.evaluate(()=>{localStorage.setItem("personal-tools-recall-signed-out","0");const channel=new BroadcastChannel("sb-zdixgamfhdgnqbgjckpj-auth-token");channel.postMessage({event:"SIGNED_IN",session:null});channel.close();});
 await page.reload();await page.getByRole("heading",{name:"金庫を解錠",exact:true}).waitFor();assert.equal(await cache(page),null);await unlockIfNeeded(page);assert.ok((await cache(page)).scope.includes(accountB));record("アカウント変更で前の保持鍵を再利用せず、パスフレーズ再入力が必要");
 assert.ok(logoutCount>0);assert.deepEqual(errors,[]);await writeFile(`${output}/vault-auth-results.json`,JSON.stringify({results,errors,service:"mocked auth boundary; no real login"},null,2));
}catch(error){console.error(error);const page=context.pages()[0];console.error((await page.locator("body").innerText()).slice(0,1800));await page.screenshot({path:`${output}/vault-auth-failure.png`,fullPage:true,timeout:3000}).catch(()=>{});throw error;}finally{await browser.close();}
