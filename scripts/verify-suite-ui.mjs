import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {verifyCollectUI} from "../tests/browser/collect-ui.mjs";
import {verifySuiteUI} from "../tests/browser/suite-ui.mjs";
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??"playwright-core");
const outputDir="work/atlas-improvement-phase-b-2026-10-31";await mkdir(outputDir,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.COLLECT_BROWSER_EXECUTABLE||undefined,headless:true});
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000},permissions:["clipboard-read","clipboard-write"]});
 const page=await context.newPage(),errors=[];page.on("pageerror",error=>errors.push(String(error)));
 try{
  await page.goto("http://127.0.0.1:3190/__verify/");await page.waitForResponse(r=>r.url().endsWith("/__verify/results"),{timeout:60000});
  assert.equal(await page.locator(".fail").count(),0,"Native IndexedDB regression");
  const collect=await verifyCollectUI(page,outputDir);
  const suite=await verifySuiteUI(page,outputDir);
  assert.deepEqual(errors,[],"Browser runtime errors");
  await writeFile(`${outputDir}/browser-results.json`,JSON.stringify({collect,suite},null,2));
 }catch(error){
  await page.screenshot({path:`${outputDir}/ui-failure.png`,fullPage:true});
  console.error((await page.locator("body").innerText()).slice(0,6000));throw error;
 }
}finally{await browser.close();}
