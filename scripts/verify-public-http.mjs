import assert from "node:assert/strict";
import {mkdir,writeFile,readFile} from "node:fs/promises";
const origin="https://personal-tools-seven-ruby.vercel.app",output=process.env.PUBLIC_VERIFICATION_OUTPUT??"work/atlas-improvement-phase-c-2026-10-31/public-verification",results=[];
await mkdir(output,{recursive:true});
async function get(path){const r=await fetch(origin+path,{redirect:"manual",signal:AbortSignal.timeout(20000)});assert.equal(r.status,200,path);results.push({path,status:r.status});return r;}
const root=await fetch(origin+"/",{redirect:"manual"});assert.ok([302,307].includes(root.status));assert.equal(new URL(root.headers.get("location"),origin).href,origin+"/atlas/");results.push({path:"/",status:root.status});
for(const app of ["atlas","recall","collect","sketchbook"]){
 const r=await get(`/${app}/`);assert.equal(r.headers.get("x-frame-options"),"DENY");assert.equal(r.headers.get("referrer-policy"),"no-referrer");assert.equal(r.headers.get(`x-${app}-public-shell`),"1");const html=await r.text();assert.ok(html.includes("PRIVATE VAULT"));
 const assets=[...new Set([...html.matchAll(/(?:src|href)="([^"\s]+\.(?:js|css)(?:\?[^"\s]*)?)"/g)].map(match=>match[1]))].filter(path=>path.includes("/_next/static/"));assert.ok(assets.length>1,app+" assets");
 for(const path of assets){assert.ok(path.startsWith(`/${app}/_next/`),path);const text=await(await get(path)).text();assert.ok(!text.includes("ATLAS_WORKER_SECRET"));assert.ok(!text.includes("api.openai.com/v1"));}
 const manifest=await(await get(`/${app}/manifest.webmanifest`)).json();assert.equal(manifest.start_url,`/${app}/`);assert.equal(manifest.scope,`/${app}/`);assert.equal(manifest.share_target,undefined);assert.equal(await(await get(`/${app}/sw.js`)).text(),await readFile(`apps/${app}/public/sw.js`,"utf8"),app+" deployed offline cache version");await get(`/${app}/icon-192.png`);await get(`/${app}/icon-512.png`);
}
const info=await get("/atlas/api/ai/");assert.match(info.headers.get("cache-control"),/no-store/);assert.equal((await info.json()).configured,false);
for(const path of ["/atlas/api/ai/","/collect/api/metadata/"]){const r=await fetch(origin+path,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}",redirect:"manual"});assert.equal(r.status,410);results.push({path,method:"POST",status:r.status});}
const callback=await fetch(origin+"/recall/auth/callback/",{redirect:"manual"});assert.ok([302,303,307].includes(callback.status));const destination=new URL(callback.headers.get("location"),origin);assert.equal(destination.origin,origin);assert.equal(destination.pathname,"/recall/");assert.match(callback.headers.get("cache-control")??"",/no-store/);results.push({path:"/recall/auth/callback/",status:callback.status,invalidLinkRedirect:true});
await writeFile(`${output}/http-results.json`,JSON.stringify({origin,checks:results.length,results},null,2));console.log(JSON.stringify({origin,checks:results.length,pass:true}));
