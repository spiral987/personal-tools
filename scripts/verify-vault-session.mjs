import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {unlockIfNeeded,fixturePassphrase} from "../tests/browser/vault-ui.mjs";
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??"playwright-core");
const output="work/atlas-improvement-phase-c-2026-10-31",origin="http://127.0.0.1:3190";
await mkdir(output,{recursive:true});
// A new test-only persistent profile proves browser-process restart, not just a tab reload.
const profile=resolve(`${output}/browser-profile-${Date.now()}`);
const options={executablePath:process.env.COLLECT_BROWSER_EXECUTABLE||undefined,headless:true,viewport:{width:1440,height:1000}};
let context=await chromium.launchPersistentContext(profile,options);const results=[],errors=[];
const record=name=>{results.push({name,pass:true});console.log(`${name}: 成功`);};
function watch(page){page.on("pageerror",error=>errors.push(String(error)));page.on("dialog",dialog=>dialog.accept());return page;}
async function enter(page,tool){await page.goto(`${origin}/${tool}/`);await unlockIfNeeded(page);await page.waitForFunction(()=>[...document.querySelectorAll(".pt-tools a")].every(a=>a.getAttribute("aria-disabled")!=="true"));}
async function raw(page){return page.evaluate(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open("personal-tools-vault-device-v1",1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});try{return await new Promise((resolve,reject)=>{const r=db.transaction("session").objectStore("session").get("active");r.onsuccess=()=>resolve(r.result?{issuedAt:r.result.issuedAt,expiresAt:r.result.expiresAt,extractable:r.result.key.extractable,indexExtractable:r.result.indexKey.extractable}:null);r.onerror=()=>reject(r.error);});}finally{db.close();}});}
try{
 let page=watch(context.pages()[0]??await context.newPage());await page.goto(origin+"/__verify/");await page.waitForResponse(r=>r.url().endsWith("/__verify/results"),{timeout:60000});assert.equal(await page.locator(".fail").count(),0);
 await enter(page,"recall");const first=await raw(page);assert.ok(first);assert.equal(first.expiresAt-first.issuedAt,86400000);assert.equal(first.extractable,false);assert.equal(first.indexExtractable,false);
 await page.getByRole("textbox",{name:"メモの本文",exact:true}).fill("再起動と全タブ保存のテスト下書き");
 for(const tool of ["collect","sketchbook","atlas","recall"]){await page.locator(`.pt-tools a[href="/${tool}/"]`).click();await page.locator(".pt-shell").waitFor();await page.waitForFunction(()=>[...document.querySelectorAll(".pt-tools a")].every(a=>a.getAttribute("aria-disabled")!=="true"));assert.equal(await page.getByRole("heading",{name:"金庫を解錠",exact:true}).count(),0);assert.equal((await raw(page)).expiresAt,first.expiresAt);}
 await page.reload();await page.locator(".pt-shell").waitFor();await page.waitForFunction(()=>[...document.querySelectorAll(".pt-tools a")].every(a=>a.getAttribute("aria-disabled")!=="true"));assert.equal(await page.getByRole("textbox",{name:"メモの本文",exact:true}).inputValue(),"再起動と全タブ保存のテスト下書き");record("4ツールの移動・再読込で再入力不要、期限は延長しない");
 await context.close();context=await chromium.launchPersistentContext(profile,options);page=watch(context.pages()[0]??await context.newPage());await page.goto(origin+"/recall/");await page.locator(".pt-shell").waitFor();await page.waitForFunction(()=>[...document.querySelectorAll(".pt-tools a")].every(a=>a.getAttribute("aria-disabled")!=="true"));assert.equal((await raw(page)).expiresAt,first.expiresAt);assert.equal(await page.getByRole("textbox",{name:"メモの本文",exact:true}).inputValue(),"再起動と全タブ保存のテスト下書き");record("ブラウザプロセス終了・再起動後、非抽出鍵で下書きを復元");
 await page.evaluate(()=>navigator.serviceWorker.ready);await context.setOffline(true);await page.reload();await unlockIfNeeded(page);assert.equal(await page.getByRole("textbox",{name:"メモの本文",exact:true}).inputValue(),"再起動と全タブ保存のテスト下書き");await context.setOffline(false);record("準備済みの公開画面をオフラインで再読込し、期限内の下書きを復元");
 await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent("pagehide",{persisted:true})));await page.getByRole("heading",{name:"金庫を解錠",exact:true}).waitFor();await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true})));await unlockIfNeeded(page);assert.equal((await raw(page)).expiresAt,first.expiresAt);record("ページ保存から復帰した場合も元の期限内で解錠を復元");
 const peer=watch(await context.newPage());await enter(peer,"collect");
 const staleCollect=watch(await context.newPage());await enter(staleCollect,"collect");
 const sketch=watch(await context.newPage());await enter(sketch,"sketchbook");const staleSketch=watch(await context.newPage());await enter(staleSketch,"sketchbook");
 // Delayed native encryption makes the initiating tab wait for the other draft commit.
 await peer.evaluate(()=>{const original=crypto.subtle.encrypt.bind(crypto.subtle);crypto.subtle.encrypt=async(...args)=>{await new Promise(resolve=>setTimeout(resolve,450));return original(...args);};});
 await page.getByRole("textbox",{name:"メモの本文",exact:true}).fill("全タブロック直前のメモ");await peer.getByRole("textbox",{name:"自分のメモ",exact:true}).fill("全タブロック直前の資料メモ");
 await sketch.getByRole("textbox",{name:"スケッチのタイトル",exact:true}).fill("全タブロック直前のスケッチ");
 assert.equal(await page.getByRole("textbox",{name:"メモの本文",exact:true}).inputValue(),"全タブロック直前のメモ");
 await page.getByRole("button",{name:"金庫をロック",exact:true}).click();
 for(const p of context.pages()){console.log("Checking locked test tab:",p.url());await p.getByRole("heading",{name:"金庫を解錠",exact:true}).waitFor();}assert.equal(await raw(page),null);
 await unlockIfNeeded(page);await enter(peer,"collect");await enter(sketch,"sketchbook");assert.equal(await page.getByRole("textbox",{name:"メモの本文",exact:true}).inputValue(),"全タブロック直前のメモ");assert.equal(await peer.getByRole("textbox",{name:"自分のメモ",exact:true}).inputValue(),"全タブロック直前の資料メモ");assert.equal(await sketch.getByRole("textbox",{name:"スケッチのタイトル",exact:true}).inputValue(),"全タブロック直前のスケッチ");record("手動ロックは全タブの保存を待ち、未編集タブが3ツールの最新下書きを上書きしない");
 for(const p of context.pages())if(p!==page)await p.close();await page.locator(".pt-settings-button").click();await page.getByLabel("解錠の保持期間",{exact:true}).selectOption("short");await page.getByRole("heading",{name:"金庫を解錠",exact:true}).waitFor();await unlockIfNeeded(page);assert.equal(await raw(page),null);
 await page.evaluate(()=>{const original=Date.now;Date.now=()=>original()+300001;});await page.getByRole("heading",{name:"金庫を解錠",exact:true}).waitFor({timeout:10000});await page.reload();await page.getByRole("heading",{name:"金庫を解錠",exact:true}).waitFor();record("設定の短時間ロックは保持鍵を残さず、無操作5分と再読込で再解錠");
 await page.getByLabel("解錠の保持期間",{exact:true}).selectOption("daily");await unlockIfNeeded(page);
 const saved=await raw(page);await page.evaluate(offset=>{const original=Date.now;Date.now=()=>original()+offset;},86400001);
 await page.getByRole("heading",{name:"金庫を解錠",exact:true}).waitFor({timeout:10000});assert.equal(await raw(page),null);record("24時間の期限超過で表示を閉じ、保持鍵を削除");
 await page.reload();await page.getByRole("heading",{name:"金庫を解錠",exact:true}).waitFor();assert.equal(await raw(page),null);
 await unlockIfNeeded(page);
 await page.evaluate(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open("personal-tools-vault-device-v1",1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});await new Promise((resolve,reject)=>{const tx=db.transaction("session","readwrite"),store=tx.objectStore("session"),r=store.get("active");r.onsuccess=()=>store.put({...r.result,scope:'["https://example.supabase.co","22222222-2222-4222-8222-222222222222"]'});tx.oncomplete=resolve;tx.onerror=reject;});db.close();});
 await page.reload();await page.getByRole("heading",{name:"金庫を解錠",exact:true}).waitFor();assert.equal(await raw(page),null);record("別アカウント・同期先の保持情報では画面を開かず鍵を削除");
 await page.screenshot({path:`${output}/vault-expired.png`,fullPage:true});assert.deepEqual(errors,[]);await writeFile(`${output}/vault-browser-results.json`,JSON.stringify({results,errors},null,2));
}catch(error){console.error(error);for(const page of context.pages())console.error(page.url(),(await page.locator("body").innerText()).slice(0,900));const page=context.pages()[0];if(page)await page.screenshot({path:`${output}/vault-failure.png`,fullPage:true,timeout:3000}).catch(()=>{});throw error;}finally{await context.close();}
