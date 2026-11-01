// Read-only production HTTP smoke check. Start the four apps before running.
import assert from "node:assert/strict";
const origin=new URL(process.argv[2]??"http://127.0.0.1:3100");
assert.ok(["127.0.0.1","localhost","[::1]"].includes(origin.hostname),"Use a local test gateway.");
const results=[];
async function get(path){const response=await fetch(new URL(path,origin),{signal:AbortSignal.timeout(15000)});assert.equal(response.status,200,path);results.push({path,status:response.status});return response;}
for(const app of ["recall","sketchbook","collect","atlas"]){const response=await get(`/${app}/`);assert.equal(response.headers.get("X-Frame-Options"),"DENY");assert.equal(response.headers.get("Referrer-Policy"),"no-referrer");const html=await response.text();assert.ok(html.includes("<html"));assert.ok(html.includes("<title>"));assert.ok(html.includes("PRIVATE VAULT"));}
const shell=await get("/atlas/");assert.equal(shell.headers.get("X-Atlas-Public-Shell"),"1");const html=await shell.text();
const assets=[...new Set([...html.matchAll(/(?:src|href)="(\/atlas\/_next\/static\/[^"\s]+\.(?:js|css))"/g)].map(m=>m[1]))];assert.ok(assets.length>1);for(const path of assets){const text=await(await get(path)).text();if(path.endsWith(".js"))for(const marker of ["OPENAI_API_KEY","ATLAS_WORKER_SECRET","api.openai.com/v1"])assert.ok(!text.includes(marker),"Server AI implementation must stay out of browser bundles");}
const manifest=await(await get("/atlas/manifest.webmanifest")).json();assert.equal(manifest.scope,"/atlas/");assert.equal(manifest.start_url,"/atlas/");assert.ok(manifest.icons.some(i=>i.sizes==="192x192"));
await get("/atlas/icon.svg");await get("/atlas/icon-192.png");await get("/atlas/icon-512.png");const sw=await(await get("/atlas/sw.js")).text();assert.ok(sw.includes('BASE="/atlas"'));
const infoResponse=await get("/atlas/api/ai/");assert.match(infoResponse.headers.get("Cache-Control"),/\bno-store\b/);const info=await infoResponse.json();assert.equal(info.configured,false,"This smoke check expects AI disabled; it never performs paid calls.");
const denied=await fetch(new URL("/atlas/api/ai/",origin),{method:"POST",headers:{Origin:"https://foreign.example","Content-Type":"application/json"},body:JSON.stringify({action:"search",query:"test"})});assert.equal(denied.status,410);results.push({path:"external AI disabled",status:denied.status});
const metadata=await fetch(new URL("/collect/api/metadata/",origin),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:"https://example.com/private"})});assert.equal(metadata.status,410);results.push({path:"external URL metadata disabled",status:metadata.status});
const collectManifest=await(await get("/collect/manifest.webmanifest")).json();assert.equal(collectManifest.share_target,undefined);
console.log(JSON.stringify({checks:results.length,results},null,2));
