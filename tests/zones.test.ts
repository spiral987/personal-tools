import test from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {sketchbookOrigin,sketchbookRewrites,collectOrigin,collectRewrites,atlasOrigin,atlasRewrites} from "../scripts/zones.mjs";
// Use the pinned Next matcher/compiler to catch real route-normalization regressions.
// These are test-only internals; production uses the documented rewrite configuration.
const require=createRequire(new URL("../apps/recall/package.json",import.meta.url));
const {getPathMatch}=require("next/dist/shared/lib/router/utils/path-match");
const {prepareDestination}=require("next/dist/shared/lib/router/utils/prepare-destination");
test("multi-zone route preserves page slashes, files, nested assets and query in the Next compiler",()=>{
  const [rule]=sketchbookRewrites("http://127.0.0.1:3301");
  assert.equal(rule.basePath,false);
  const match=getPathMatch(rule.source,{strict:true});
  for(const pathname of ["/sketchbook/","/sketchbook/deep/page/","/sketchbook/manifest.webmanifest","/sketchbook/sw.js","/sketchbook/_next/static/chunks/app/page.js"]){
    const params=match(pathname);assert.ok(params,pathname);
    const {parsedDestination}=prepareDestination({destination:rule.destination,params,query:{from:"note-123",item:"sketch-456"},appendParamsToQuery:false});
    assert.equal(parsedDestination.pathname,pathname,`Do not add/drop '/' for ${pathname}`);
    assert.deepEqual(parsedDestination.query,{from:"note-123",item:"sketch-456"});
    assert.equal(parsedDestination.origin,"http://127.0.0.1:3301");
  }
  assert.equal(match("/recall/"),false);assert.equal(match("/sketchbook-foreign/"),false);
  assert.equal(sketchbookOrigin("https://sketch.example.com/"),"https://sketch.example.com");
});
test("zone destination accepts an origin, never credentials, arbitrary paths or nonlocal plaintext",()=>{
  for(const input of ["https://user:secret@example.com","https://example.com/sketchbook","https://example.com/?secret=x","https://example.com/#x","http://example.com","file:///C:/secrets"]){assert.throws(()=>sketchbookOrigin(input));assert.throws(()=>collectOrigin(input));assert.throws(()=>atlasOrigin(input));}
});
test("Atlas zone preserves AI routes, item links, manifest and static assets in the Next compiler",()=>{
 const [rule]=atlasRewrites("http://127.0.0.1:3504"),match=getPathMatch(rule.source,{strict:true});
 for(const pathname of ["/atlas/","/atlas/api/ai/","/atlas/manifest.webmanifest","/atlas/sw.js","/atlas/_next/static/chunks/app/page.js"]){
  const params=match(pathname);assert.ok(params);const {parsedDestination}=prepareDestination({destination:rule.destination,params,query:{item:"original-id"},appendParamsToQuery:false});assert.equal(parsedDestination.pathname,pathname);assert.deepEqual(parsedDestination.query,{item:"original-id"});assert.equal(parsedDestination.origin,"http://127.0.0.1:3504");
 }
 assert.equal(match("/atlas-foreign/"),false);
});

test("Collect rewrite preserves share queries, metadata route and its independent asset paths",()=>{
  const [rule]=collectRewrites("http://127.0.0.1:3403");
  assert.equal(rule.basePath,false);
  const match=getPathMatch(rule.source,{strict:true});
  for(const pathname of ["/collect/","/collect/api/metadata/","/collect/manifest.webmanifest","/collect/sw.js","/collect/_next/static/chunks/app/page.js"]){
    const params=match(pathname);assert.ok(params,pathname);
    const {parsedDestination}=prepareDestination({destination:rule.destination,params,query:{title:"共有",url:"https://example.com/?a=1&b=2"},appendParamsToQuery:false});
    assert.equal(parsedDestination.pathname,pathname);
    assert.deepEqual(parsedDestination.query,{title:"共有",url:"https://example.com/?a=1&b=2"});
    assert.equal(parsedDestination.origin,"http://127.0.0.1:3403");
  }
  assert.equal(match("/recall/"),false);assert.equal(match("/collect-foreign/"),false);
  assert.equal(collectOrigin("https://collect.example.com/"),"https://collect.example.com");
});
