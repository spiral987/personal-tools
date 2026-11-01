import {unlockIfNeeded} from "./vault-ui.mjs";
import assert from "node:assert/strict";
const origin="http://127.0.0.1:3190",passphrase="browser-verification-fixture-only-2026";
const tools=["atlas","recall","collect","sketchbook"];
const titles={atlas:"Atlasホーム",recall:"メモを書く",collect:"資料を追加",sketchbook:"スケッチを描く"};

export async function verifySuiteUI(page,outputDir){
 const results=[],record=(name,details)=>{results.push({name,pass:true,...details});console.log(`${name}: 成功`);};
 async function unlock(tool){
  await unlockIfNeeded(page);
  await page.getByRole("heading",{name:titles[tool],exact:true}).waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll(".pt-tools a")].every(a=>a.getAttribute("aria-disabled")!=="true"));
 }
 async function enter(tool){await page.goto(`${origin}/${tool}/`);await unlock(tool);}
 async function follow(tool,mobile=false){
  const nav=page.locator(mobile?".pt-mobile-tools":".pt-tools");
  await nav.locator(`a[href="/${tool}/"]`).click();
  await page.waitForURL(url=>url.pathname===`/${tool}/`);await unlock(tool);
 }
 page.on("dialog",dialog=>dialog.accept());
 await page.goto(origin+"/");await page.waitForURL(url=>url.pathname==="/atlas/");await unlock("atlas");
 assert.equal(await page.locator(".pt-entrances a").count(),3);
 record("ルートURLはAtlasホームへ移動し、3ツールへの入口を表示");

 const geometry=[];
 for(const mobile of [false,true]){
  await page.setViewportSize({width:mobile?390:1440,height:mobile?844:1000});
  for(const from of tools){
   await enter(from);
   const current=page.locator(mobile?".pt-mobile-tools":".pt-tools").locator('[aria-current="page"]');
   assert.equal(await current.getAttribute("href"),`/${from}/`);
   assert.equal(await page.locator(mobile?".pt-mobile-tools a":".pt-tools a").count(),4);
   assert.equal(await page.locator(".pt-search input").count(),1);
   const dimensions=await page.evaluate(()=>{
    const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
    return {topbar:rect(".pt-topbar"),search:rect(".pt-search"),settings:rect(".pt-settings-button"),spaces:rect(".pt-spaces .pt-side-heading"),overflow:document.documentElement.scrollWidth>innerWidth,font:getComputedStyle(document.querySelector(".pt-page-heading h1")).fontFamily,brand:getComputedStyle(document.querySelector(".pt-brand")).color,ink:getComputedStyle(document.querySelector(".pt-shell")).color};
   });
   assert.equal(dimensions.overflow,false,`${from}: page overflow`);
   assert.equal(dimensions.brand,dimensions.ink,`${from}: unstyled brand link`);
   if(!mobile)geometry.push({tool:from,...dimensions});
   await page.screenshot({path:`${outputDir}/suite-${from}-${mobile?"mobile":"desktop"}.png`,fullPage:true});
   if(mobile){
    if(from==="sketchbook"){
     const card=await page.locator(".pt-record-grid .gallery-card").first().boundingBox(),grid=await page.locator(".pt-record-grid").first().boundingBox();
     assert.ok(card&&grid&&Math.abs(card.width-grid.width)<2,"Mobile sketch gallery width");
    }
    await page.evaluate(()=>scrollTo(0,document.body.scrollHeight));
    const box=await page.locator(".pt-mobile-tools").boundingBox();assert.ok(box&&Math.abs(box.y-59)<2,`${from}: mobile navigation scrolled away`);
    await page.evaluate(()=>scrollTo(0,0));
   }
   for(const to of tools.filter(tool=>tool!==from)){
    await follow(to,mobile);await follow(from,mobile);
   }
   await page.locator(".pt-settings-button").click();
   await page.getByRole("dialog").filter({has:page.getByRole("heading",{name:"保存とアカウント",exact:true})}).waitFor();
   await page.getByRole("button",{name:"閉じる",exact:true}).click();
  }
 }
 for(const item of geometry.slice(1)){
  assert.equal(item.font,geometry[0].font,`${item.tool}: inconsistent font`);
  for(const selector of ["topbar","search","settings","spaces"]){
  for(const key of ["x","y","width","height"])assert.ok(Math.abs(item[selector][key]-geometry[0][selector][key])<2,`${item.tool}: inconsistent ${selector}.${key}`);
  }
 }
 record("PC・390px幅で全4ツールの相互移動、現在地、設定、検索位置を確認",{navigationPairs:24,geometry});
 record("スマホのツール切替はスクロール後も常に表示");

 await page.setViewportSize({width:1440,height:1000});await enter("recall");
 await page.getByRole("textbox",{name:"メモの本文",exact:true}).fill("移動直前の未保存メモ");
 await follow("collect");await follow("recall");
 assert.equal(await page.getByRole("textbox",{name:"メモの本文",exact:true}).inputValue(),"移動直前の未保存メモ");
 record("Recallの入力直後に移動してもメモの下書きが戻る");

 await page.evaluate(()=>{
  const put=IDBObjectStore.prototype.put;window.__restoreSuiteQuota=()=>{IDBObjectStore.prototype.put=put;};
  IDBObjectStore.prototype.put=function(...args){if(this.name==="drafts")throw new DOMException("移動前保存の容量エラー","QuotaExceededError");return put.apply(this,args);};
 });
 await page.getByRole("textbox",{name:"メモの本文",exact:true}).fill("失敗しても残す本文");
 await page.locator('.pt-tools a[href="/atlas/"]').click();
 await page.getByRole("alert").filter({hasText:"移動前保存の容量エラー"}).waitFor();
 assert.equal(new URL(page.url()).pathname,"/recall/");assert.equal(await page.getByRole("textbox",{name:"メモの本文",exact:true}).inputValue(),"失敗しても残す本文");
 await page.evaluate(()=>window.__restoreSuiteQuota());await follow("atlas");
 record("下書き保存に失敗したときは移動せず、入力を残して再試行できる");

 await follow("collect");
 const png=await page.evaluate(()=>{const c=document.createElement("canvas");c.width=128;c.height=96;const x=c.getContext("2d");x.fillStyle="#7471a2";x.fillRect(0,0,128,96);return c.toDataURL("image/png").split(",")[1];});
 await page.getByRole("textbox",{name:"収集のタイトル",exact:true}).fill("移動する画像下書き");
 await page.getByRole("textbox",{name:"自分のメモ",exact:true}).fill("画像と一緒に残す本文");
 await page.locator('input[type="file"][accept="image/png,image/jpeg,image/gif,image/webp"]').setInputFiles({name:"navigation.png",mimeType:"image/png",buffer:Buffer.from(png,"base64")});
 await page.waitForFunction(()=>document.querySelector(".draft-preview")?.naturalWidth===128);
 await follow("sketchbook");await follow("collect");
 assert.equal(await page.getByRole("textbox",{name:"収集のタイトル",exact:true}).inputValue(),"移動する画像下書き");
 assert.equal(await page.getByRole("textbox",{name:"自分のメモ",exact:true}).inputValue(),"画像と一緒に残す本文");
 await page.waitForFunction(()=>document.querySelector(".draft-preview")?.naturalWidth===128);
 record("Collectの画像原本・タイトル・メモがツール移動後も下書きとして復元");

 await follow("sketchbook");
 await page.getByRole("textbox",{name:"スケッチのタイトル",exact:true}).fill("移動する描画下書き");
 await page.getByRole("button",{name:"Recallのメモを関連付ける",exact:true}).click();
 await page.getByRole("dialog").getByRole("button").filter({hasText:"関連リンクの検証用メモ"}).click();
 const canvas=page.getByLabel("スケッチ用キャンバス。ペン、指、マウスで描けます。");
 await canvas.evaluate(element=>element.scrollIntoView({block:"start"}));
 const box=await canvas.boundingBox();assert.ok(box);
 await page.mouse.move(box.x+30,box.y+30);await page.mouse.down();await page.mouse.move(box.x+130,box.y+80,{steps:5});
 await page.waitForFunction(()=>document.querySelector('.pt-tools a[href="/atlas/"]')?.getAttribute("aria-disabled")==="true");
 await page.locator('.pt-tools a[href="/atlas/"]').focus();await page.keyboard.press("Enter");
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(new URL(page.url()).pathname,"/sketchbook/");await page.mouse.up();
 await page.locator(".paper-footer").filter({hasText:"1 strokes"}).waitFor();
 await follow("atlas");await follow("sketchbook");
 assert.equal(await page.getByRole("textbox",{name:"スケッチのタイトル",exact:true}).inputValue(),"移動する描画下書き");
 await page.locator(".paper-footer").filter({hasText:"1 strokes"}).waitFor();
 await page.locator(".pending-source").filter({hasText:"関連リンクの検証用メモ"}).waitFor();
 record("描画中は移動せず、描き終えた線・タイトル・未保存の関連メモが移動後に戻る");

 await follow("atlas");
 await page.locator(".pt-search input").fill("関連リンクの検証用メモ");
 await page.locator(".item-card").filter({hasText:"関連リンクの検証用メモ"}).click();
 await page.getByRole("button",{name:"＋ 新しいプロジェクト",exact:true}).click();
 await page.getByRole("dialog").getByLabel("名前",{exact:true}).fill("共通UIの検証プロジェクト");
 await page.getByRole("dialog").getByRole("button",{name:"保存する",exact:true}).click();
 await page.locator(".pt-sidebar-extra").getByRole("button",{name:"共通UIの検証プロジェクト",exact:true}).waitFor();
 await page.locator(".pt-sidebar-extra").getByRole("button",{name:"共通UIの検証プロジェクト",exact:true}).click();
 assert.equal(await page.locator(".item-card").count(),1);
 await page.locator(".original-link").click();await page.waitForURL(url=>url.pathname==="/recall/");
 await unlock("recall");await page.getByRole("dialog").getByRole("textbox",{name:"メモを編集",exact:true}).waitFor();
 assert.equal(await page.getByRole("dialog").getByRole("textbox",{name:"メモを編集",exact:true}).inputValue(),"関連リンクの検証用メモ");
 await page.getByRole("dialog").getByRole("button",{name:"閉じる",exact:true}).last().click();
 record("Atlasの横断検索・プロジェクト・既存原本リンクが共通UIでも使える");

 await page.setViewportSize({width:390,height:844});
 await follow("collect",true);assert.equal(await page.getByRole("textbox",{name:"収集のタイトル",exact:true}).inputValue(),"移動する画像下書き");
 await follow("sketchbook",true);await page.locator(".paper-footer").filter({hasText:"1 strokes"}).waitFor();
 await follow("recall",true);assert.equal(await page.getByRole("textbox",{name:"メモの本文",exact:true}).inputValue(),"失敗しても残す本文");
 record("スマホ幅でもメモ・画像・描画の下書きを残して相互移動できる");
 await page.getByRole("textbox",{name:"メモの本文",exact:true}).fill("ロック直前の下書き");
 await page.getByRole("button",{name:"金庫をロック",exact:true}).click();await unlock("recall");
 assert.equal(await page.getByRole("textbox",{name:"メモの本文",exact:true}).inputValue(),"ロック直前の下書き");
 record("共通ヘッダーの手動ロックで下書きを保存し、再解錠で復元");
 return results;
}
