import {unlockIfNeeded} from "./vault-ui.mjs";
import assert from "node:assert/strict";

// Accept a Playwright Page from the caller; use an isolated browser context and
// the verification server's origin, never the user's normal app storage.
export async function verifyCollectUI(page,outputDir){
 const passphrase="browser-verification-fixture-only-2026",results=[];
 const record=name=>{results.push({name,pass:true});console.log(`${name}: 成功`);};
 const png=await page.evaluate(()=>{
  const canvas=document.createElement("canvas");canvas.width=128;canvas.height=96;
  const ctx=canvas.getContext("2d");ctx.fillStyle="#7d927a";ctx.fillRect(0,0,128,96);ctx.fillStyle="#e8b969";ctx.fillRect(12,12,80,55);
  return canvas.toDataURL("image/png").split(",")[1];
 });
 const fixture={name:"selected-original.png",mimeType:"image/png",buffer:Buffer.from(png,"base64")};
 const memo=()=>page.getByRole("textbox",{name:"自分のメモ",exact:true});
 const title=()=>page.getByRole("textbox",{name:"収集のタイトル",exact:true});
 const savedDraft=()=>page.locator(".draft-state").filter({hasText:"下書きを端末に保存済み"}).waitFor();
 async function unlock(){
  await unlockIfNeeded(page);
  await page.getByRole("textbox",{name:"収集するURL",exact:true}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('[aria-label="収集するURL"]').disabled);
 }
 async function imageClipboard(){
  await page.evaluate(async value=>{
   const bytes=Uint8Array.from(atob(value),c=>c.charCodeAt(0));
   await navigator.clipboard.write([new ClipboardItem({"image/png":new Blob([bytes],{type:"image/png"})})]);
  },png);
 }
 const loadPreview=()=>page.waitForFunction(()=>{const image=document.querySelector(".draft-preview");return image?.complete&&image.naturalWidth===128;});
 page.on("dialog",dialog=>dialog.accept());
 await page.goto("http://127.0.0.1:3190/collect/");await unlock();
 await title().fill("選択画像");await memo().fill("ファイル選択のメモ");
 await page.locator('input[type="file"][accept="image/png,image/jpeg,image/gif,image/webp"]').setInputFiles(fixture);
 await loadPreview();await savedDraft();
 record("画面での画像ファイル選択・下書き自動保存");

 await page.reload();
 await unlockIfNeeded(page);
 await loadPreview();assert.equal(await memo().inputValue(),"ファイル選択のメモ");
 await page.getByRole("button",{name:"収集箱に残す",exact:true}).click();
 await page.getByRole("button",{name:"開く: 選択画像",exact:true}).waitFor();
 await page.waitForFunction(()=>{const image=document.querySelector(".card-preview img");return image?.complete&&image.naturalWidth===128;});
 record("再読込後の画像下書き復元・投稿・原本表示");

 await title().fill("貼り付け画像");await memo().fill("置き換えないメモ");
 await page.getByRole("textbox",{name:"収集するURL",exact:true}).fill("https://example.test/source");
 await imageClipboard();await memo().focus();await page.keyboard.press("Control+End");await page.keyboard.press("Control+V");
 await loadPreview();await savedDraft();
 assert.equal(await title().inputValue(),"貼り付け画像");assert.equal(await memo().inputValue(),"置き換えないメモ");
 assert.equal(await page.getByRole("textbox",{name:"出典URL",exact:true}).inputValue(),"https://example.test/source");
 await imageClipboard();await memo().focus();await page.keyboard.press("Control+V");
 await page.getByRole("status").filter({hasText:"画像が選択されています"}).waitFor();
 assert.equal(await memo().inputValue(),"置き換えないメモ");
 await page.getByRole("button",{name:"収集箱に残す",exact:true}).click();
 await page.getByRole("button",{name:"開く: 貼り付け画像",exact:true}).waitFor();
 record("Ctrl+Vで画像を保存し、本文・タイトル・出典・選択済み画像を保持");

 await page.reload();await unlock();
 assert.equal(await page.locator(".resource-card").count()||await page.locator(".card-open").count(),2);
 await page.getByRole("button",{name:"開く: 貼り付け画像",exact:true}).click();await loadPreview();
 assert.equal(await memo().inputValue(),"置き換えないメモ");
 await page.screenshot({path:`${outputDir}/collect-desktop.png`,fullPage:true});
 record("投稿した2枚の原本が再読込後も表示される");

 await imageClipboard();await memo().focus();await page.keyboard.press("Control+V");
 await page.getByRole("status").filter({hasText:"新しい収集"}).waitFor();
 assert.equal(await title().inputValue(),"貼り付け画像");
 record("保存済み資料の編集中に画像貼り付けで原本を変更しない");

 await page.getByRole("button",{name:"新しい収集",exact:true}).click();
 await memo().fill("通常の文章: ");
 await page.evaluate(()=>navigator.clipboard.writeText("貼り付けた本文"));
 await memo().focus();await page.keyboard.press("Control+End");await page.keyboard.press("Control+V");
 assert.equal(await memo().inputValue(),"通常の文章: 貼り付けた本文");
 record("画像を含まない文章のCtrl+Vは標準動作を維持");

 const before=await memo().inputValue();
 await memo().evaluate(element=>{const data=new DataTransfer();data.items.add(new File(["not an image"],"broken.png",{type:"image/png"}));element.dispatchEvent(new ClipboardEvent("paste",{clipboardData:data,bubbles:true,cancelable:true}));});
 await page.getByRole("alert").filter({hasText:"PNG・JPEG・GIF・WebP"}).waitFor();
 assert.equal(await memo().inputValue(),before);assert.equal(await page.locator(".draft-preview").count(),0);
 record("壊れた画像の貼り付けは入力を保持して拒否");

 await page.evaluate(()=>{
  const put=IDBObjectStore.prototype.put;
  window.__restoreQuota=()=>{IDBObjectStore.prototype.put=put;};
  IDBObjectStore.prototype.put=function(...args){if(this.name==="resourceFiles")throw new DOMException("容量不足の検証","QuotaExceededError");return put.apply(this,args);};
 });
 await title().fill("再試行画像");
 await page.locator('input[type="file"][accept="image/png,image/jpeg,image/gif,image/webp"]').setInputFiles(fixture);
 await loadPreview();await page.getByRole("alert").filter({hasText:"容量不足の検証"}).waitFor();
 await page.getByRole("button",{name:"収集箱に残す",exact:true}).click();
 await page.getByRole("alert").filter({hasText:"容量不足の検証"}).waitFor();
 assert.equal(await page.locator(".card-open").count(),2);
 assert.equal(await title().inputValue(),"再試行画像");assert.equal(await memo().inputValue(),before);
 assert.notEqual(await page.locator(".draft-state").innerText(),"下書きを端末に保存済み");
 await page.evaluate(()=>window.__restoreQuota());
 await page.getByRole("button",{name:"収集箱に残す",exact:true}).click();
 await page.getByRole("button",{name:"開く: 再試行画像",exact:true}).waitFor();
 record("容量エラーでは保存済みと表示せず入力を保持し、再試行で投稿できる");

 await page.setViewportSize({width:390,height:844});
 await title().fill("モバイル幅の画像");await imageClipboard();await memo().focus();await page.keyboard.press("Control+V");
 await loadPreview();await savedDraft();
 await page.getByRole("button",{name:"収集箱に残す",exact:true}).click();
 await page.getByRole("button",{name:"開く: モバイル幅の画像",exact:true}).waitFor();
 await page.screenshot({path:`${outputDir}/collect-mobile.png`,fullPage:true});
 record("スマートフォン幅で画像貼り付け・投稿");

 await page.setViewportSize({width:1440,height:1000});
 await page.goto("http://127.0.0.1:3190/recall/");
 await unlockIfNeeded(page);
 await page.getByRole("heading",{name:"メモを書く",exact:true}).waitFor();
 await page.locator(".note-connections a").filter({hasText:"関連リンクの検証用スケッチ"}).waitFor();
 assert.equal(await page.getByText("このメモから描く",{exact:true}).count(),0);
 assert.equal(await page.getByText("小さな思考が、いつかつながる。",{exact:true}).count(),0);
 await page.screenshot({path:`${outputDir}/recall-desktop.png`,fullPage:true});
 record("Recallの作成ボタンとコピーを削除し、既存の関連スケッチへのリンクを維持");
 return results;
}
