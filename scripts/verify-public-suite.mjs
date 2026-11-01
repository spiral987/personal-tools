import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {fixturePassphrase,unlockIfNeeded} from "../tests/browser/vault-ui.mjs";
import {verifyPublishedLifecycle} from "../tests/browser/published-lifecycle.mjs";
const lifecycle=process.argv.includes("--lifecycle");
const origin="https://personal-tools-seven-ruby.vercel.app",output=lifecycle?"work/atlas-improvement-phase-d-2026-11-01/public-verification":"work/atlas-improvement-phase-c-2026-10-31/public-verification";
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??"playwright-core");
await mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.COLLECT_BROWSER_EXECUTABLE||undefined,headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),results=[],errors=[];
page.on("dialog",dialog=>dialog.accept());page.on("pageerror",error=>errors.push(String(error)));
const record=name=>{results.push({name,pass:true});console.log(`${name}: 成功`);};
async function ready(){await page.locator(".pt-shell").waitFor();await page.waitForFunction(()=>[...document.querySelectorAll(".pt-tools a")].every(a=>a.getAttribute("aria-disabled")!=="true"));assert.equal(new URL(page.url()).origin,origin);}
async function offlineReload(){await page.evaluate(()=>navigator.serviceWorker.ready);await page.waitForFunction(()=>!!navigator.serviceWorker.controller);await context.setOffline(true);try{await page.reload();await ready();}finally{await context.setOffline(false);}}
async function follow(tool,mobile=false){await page.locator(`${mobile?".pt-mobile-tools":".pt-tools"} a[href="/${tool}/"]`).click();await page.waitForURL(url=>url.pathname===`/${tool}/`);await ready();assert.equal(await page.getByRole("heading",{name:"金庫を解錠",exact:true}).count(),0);}
try{
 // All writes stay in a fresh browser context, in device mode. No real login or cloud writes.
 await page.goto(origin+"/");await page.waitForURL(url=>url.pathname==="/atlas/");
 await page.getByLabel("専用パスフレーズ",{exact:true}).fill(fixturePassphrase);await page.getByLabel("パスフレーズをもう一度",{exact:true}).fill(fixturePassphrase);
 await page.getByRole("button",{name:"金庫と復旧鍵を作る",exact:true}).click();await page.getByRole("heading",{name:"復旧鍵を別に保管",exact:true}).waitFor();
 await page.getByRole("checkbox").check();await page.getByRole("button",{name:"暗号化した金庫を開く",exact:true}).click();await ready();record("公開HTTPSの入口からAtlasへ進み、テスト専用の金庫を作成");await offlineReload();
 await follow("recall");const note="公開確認用のメモ（テスト専用）";await page.getByRole("textbox",{name:"メモの本文",exact:true}).fill(note);await page.getByRole("button",{name:"メモを残す",exact:true}).click();await page.locator(".note-body").filter({hasText:note}).waitFor();await offlineReload();await page.locator(".note-body").filter({hasText:note}).waitFor();
 await follow("collect");const png=await page.evaluate(()=>{const canvas=document.createElement("canvas");canvas.width=128;canvas.height=96;const c=canvas.getContext("2d");c.fillStyle="#7d927a";c.fillRect(0,0,128,96);return canvas.toDataURL("image/png").split(",")[1];});
 await page.getByRole("textbox",{name:"収集のタイトル",exact:true}).fill("公開確認用の画像");await page.getByRole("textbox",{name:"自分のメモ",exact:true}).fill("端末内だけのテスト画像");
 await page.locator('input[type="file"][accept="image/png,image/jpeg,image/gif,image/webp"]').setInputFiles({name:"public-fixture.png",mimeType:"image/png",buffer:Buffer.from(png,"base64")});await page.waitForFunction(()=>{const image=document.querySelector(".draft-preview");return image?.complete&&image.naturalWidth===128;});
 await page.getByRole("button",{name:"収集箱に残す",exact:true}).click();await page.getByRole("button",{name:"開く: 公開確認用の画像",exact:true}).waitFor();await offlineReload();await page.waitForFunction(()=>{const image=document.querySelector(".card-preview img");return image?.complete&&image.naturalWidth===128;});record("公開URLのRecallでメモ、Collectで画像原本を保存");
 await follow("sketchbook");await page.getByRole("textbox",{name:"スケッチのタイトル",exact:true}).fill("公開確認用の描画下書き");const canvas=page.getByLabel("スケッチ用キャンバス。ペン、指、マウスで描けます。");await canvas.scrollIntoViewIfNeeded();const box=await canvas.boundingBox();assert.ok(box);await page.mouse.move(box.x+30,box.y+30);await page.mouse.down();await page.mouse.move(box.x+130,box.y+80,{steps:5});await page.mouse.up();await page.locator(".paper-footer").filter({hasText:"1 strokes"}).waitFor();
 await offlineReload();await page.locator(".paper-footer").filter({hasText:"1 strokes"}).waitFor();record("4ツールを初回の準備直後にオフラインで再読込し、画像原本・メモ・描画を復元");
 await follow("atlas");await page.locator(".pt-search input").fill(note);await page.locator(".item-card").filter({hasText:note}).waitFor();await page.locator(".pt-search input").fill("");await page.locator(".item-card").filter({hasText:"公開確認用の画像"}).waitFor();
 await follow("sketchbook");assert.equal(await page.getByRole("textbox",{name:"スケッチのタイトル",exact:true}).inputValue(),"公開確認用の描画下書き");await page.locator(".paper-footer").filter({hasText:"1 strokes"}).waitFor();await page.reload();await ready();await page.locator(".paper-footer").filter({hasText:"1 strokes"}).waitFor();record("4ツールが同じoriginで記録を共有し、描画下書きと解錠を再読込後も保持");
 await page.setViewportSize({width:390,height:844});for(const tool of ["atlas","recall","collect","sketchbook"]){await follow(tool,true);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:`${output}/${tool}-mobile.png`,fullPage:true});}record("公開URLの390px幅で全ツールを移動し、横はみ出しなし");
 await follow("recall",true);await page.getByRole("textbox",{name:"メモの本文",exact:true}).fill("公開URLのロック直前の下書き");await page.getByRole("button",{name:"金庫をロック",exact:true}).click();await page.getByRole("heading",{name:"金庫を解錠",exact:true}).waitFor();await unlockIfNeeded(page);assert.equal(await page.getByRole("textbox",{name:"メモの本文",exact:true}).inputValue(),"公開URLのロック直前の下書き");record("公開URLでも手動ロックで再解錠となり、直前の下書きを復元");
 await page.setViewportSize({width:1440,height:1000});await follow("atlas");await page.screenshot({path:`${output}/atlas-desktop.png`,fullPage:true});if(lifecycle)await verifyPublishedLifecycle(page,{follow,record,output});assert.deepEqual(errors,[]);await writeFile(`${output}/browser-results.json`,JSON.stringify({origin,results,errors,storage:"fresh isolated device context; no real account login"},null,2));
}catch(error){console.error(error);console.error((await page.locator("body").innerText()).slice(0,2000));await page.screenshot({path:`${output}/failure.png`,fullPage:true,timeout:5000}).catch(()=>{});throw error;}finally{await browser.close();}
