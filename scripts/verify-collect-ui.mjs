import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {verifyCollectUI} from "../tests/browser/collect-ui.mjs";

// Supply an installed Playwright module and Chromium executable if they are not
// on the normal module/browser search paths. No user browser profile is opened.
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??"playwright-core");
const outputDir="work/atlas-improvement-2026-10-31";
await mkdir(outputDir,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.COLLECT_BROWSER_EXECUTABLE||undefined,headless:true});
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000},permissions:["clipboard-read","clipboard-write"]});
 const page=await context.newPage(),errors=[];
 page.on("pageerror",error=>errors.push(String(error)));
 await page.goto("http://127.0.0.1:3190/__verify/");
 await page.waitForResponse(r=>r.url().endsWith("/__verify/results"),{timeout:60000});
 console.log(await page.locator("#results").innerText());
 assert.equal(await page.locator(".fail").count(),0,"Native IndexedDB checks failed");
 await page.screenshot({path:`${outputDir}/native-browser.png`,fullPage:true});
 try{
  const results=await verifyCollectUI(page,outputDir);
  assert.deepEqual(errors,[],"Browser runtime errors");
  await writeFile(`${outputDir}/browser-ui-results.json`,JSON.stringify(results,null,2));
 }catch(error){
  await page.screenshot({path:`${outputDir}/ui-failure.png`,fullPage:true});
  console.error((await page.locator("body").innerText()).slice(0,4500));throw error;
 }
}finally{await browser.close();}
