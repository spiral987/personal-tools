import test from "node:test";
import assert from "node:assert/strict";
import {aiConfig,analyzeItem,embedText,parseEmbedding} from "../apps/atlas/lib/ai.ts";
import {handleAtlasAI} from "../apps/atlas/lib/handler.ts";
import {runWorkerOnce} from "../scripts/atlas-worker.ts";
import {evaluateAtlas} from "../scripts/evaluate-atlas.ts";
import type {Note} from "../packages/core/src/index.ts";
import {createHash} from "node:crypto";
const config={key:"test-secret-do-not-log",visionModel:"vision-test",embeddingModel:"embedding-test",model:"openai:vision-test:caption-ocr-v1"};
const env={ATLAS_AI_ENABLED:"true",OPENAI_API_KEY:config.key,ATLAS_VISION_MODEL:config.visionModel,ATLAS_EMBEDDING_MODEL:config.embeddingModel,NEXT_PUBLIC_SUPABASE_URL:"https://example.supabase.co",ATLAS_WORKER_SECRET:"worker-secret-test"};
const now=new Date().toISOString(),owner="11111111-1111-4111-8111-111111111111";
const item:Note={id:crypto.randomUUID(),kind:"note",originApp:"recall",ownerId:owner,body:"青い夕方の路地",spaceIds:[],pinned:false,createdAt:now,updatedAt:now,deletedAt:null,localRevision:1,serverRevision:1};
const reply=(v:unknown)=>Response.json(v);
const success={status:"completed",output:[{type:"message",content:[{type:"output_text",text:JSON.stringify({caption:"夕方の道",ocr:"青い看板",suggestions:["路地","夕景"]})}]}]};
test("Atlas provider: disabled by default, server-only models and bounded finite embeddings",()=>{
 assert.equal(aiConfig({}),null);assert.equal(aiConfig({...env,ATLAS_AI_ENABLED:"false"}),null);assert.equal(aiConfig(env)?.model,config.model);
 for(const value of [[],[NaN],[Infinity],[0,0],Array(8193).fill(1),[null],"vector"])assert.throws(()=>parseEmbedding(value));assert.deepEqual(parseEmbedding([1,2]),[1,2]);
});
test("Atlas provider: caption/OCR schema and image stay in fixed API request; manual tags are never returned as edits",async()=>{
 const calls:{url:string;body:any}[]=[];const fetcher:typeof fetch=async(input,init)=>{calls.push({url:String(input),body:JSON.parse(String(init?.body))});return calls.length===1?reply(success):reply({model:"embedding-test",data:[{embedding:[1,0]}]});};
 const result=await analyzeItem(config,item,{base64:"test-image",mimeType:"image/png"},fetcher);
 assert.deepEqual(result.suggestions,["路地","夕景"]);assert.equal(calls[0].url,"https://api.openai.com/v1/responses");assert.equal(calls[0].body.store,false);assert.equal(calls[0].body.text.format.strict,true);assert.ok(calls[0].body.input[0].content.some((v:any)=>v.image_url==="data:image/png;base64,test-image"));assert.equal(calls[1].url,"https://api.openai.com/v1/embeddings");assert.match(calls[1].body.input,/青い看板/);
});
test("Atlas provider: incomplete, refused, malformed and wrong-model responses fail closed",async()=>{
 for(const value of [{...success,status:"incomplete"},{status:"completed",output:[{type:"message",content:[{type:"refusal",refusal:"no"}]}]},{status:"completed",output:[{type:"message",content:[{type:"output_text",text:'{"caption":"x"}'}]}]},{...success,output:[{type:"message",content:[{type:"output_text",text:JSON.stringify({caption:"a",ocr:"",suggestions:["x".repeat(41)]})}]}]}])await assert.rejects(analyzeItem(config,item,null,async()=>reply(value)));
 await assert.rejects(embedText(config,"query",async()=>reply({model:"another",data:[{embedding:[1,0]}]})),/mismatch/);
 await assert.rejects(embedText(config,"query",async()=>new Response("private error",{status:429})),e=>e instanceof Error&&!e.message.includes("private"));
});
test("Atlas embeddings: long Japanese OCR is bounded in bytes without splitting Unicode",async()=>{
 let body:any;await embedText(config,"夕🌆".repeat(8000),async(_url,init)=>{body=JSON.parse(String(init?.body));return reply({model:config.embeddingModel,data:[{embedding:[1,0]}]});});
 assert.ok(new TextEncoder().encode(body.input).length<=6000);assert.equal(body.input.includes("\uFFFD"),false);assert.ok(body.input.startsWith("夕🌆"));
});
const req=(body:unknown,origin="https://tools.example.com")=>new Request("https://tools.example.com/atlas/api/ai/",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify(body)});
test("Atlas API: origin, configured models, verified login and consent gate all paid calls",async()=>{
 let calls=0;const deps={config:()=>config,authenticate:async()=>null,embed:async()=>{calls++;return [1,0];}};
 assert.equal((await handleAtlasAI(req({action:"search",query:"夕景"},"https://foreign.example"),deps)).status,403);
 assert.equal((await handleAtlasAI(req({action:"search",query:"夕景"}),deps)).status,401);
 assert.equal((await handleAtlasAI(req({action:"search",query:"夕景"}),{...deps,config:()=>null})).status,503);
 assert.equal((await handleAtlasAI(req({action:"search",query:"夕景"}),{...deps,authenticate:async()=>({id:owner,enabled:false,client:{rpc:async()=>({data:[],error:null})}})})).status,403);assert.equal(calls,0);
});
test("Atlas API: filters enter SQL RPC before LIMIT and browser cannot select a paid model",async()=>{
 let rpcName="",rpcArgs:any,embedded="";
 const deps={config:()=>config,authenticate:async()=>({id:owner,enabled:true,client:{async rpc(name:string,args:Record<string,unknown>){rpcName=name;rpcArgs=args;return {data:[],error:null};}}}),embed:async(_config:unknown,query:string)=>{embedded=query;return [1,0];}};
 const response=await handleAtlasAI(req({action:"search",query:"青い光",spaceId:"creative",kind:"resource",tag:"都市",model:"untrusted"}),deps);assert.equal(response.status,200);assert.equal(embedded,"青い光");assert.equal(rpcName,"match_atlas_documents");assert.equal(rpcArgs.p_space,"creative");assert.equal(rpcArgs.p_kind,"resource");assert.equal(rpcArgs.p_tag,"都市");assert.equal(rpcArgs.p_model,config.model);
 assert.equal((await handleAtlasAI(req({action:"queue",itemId:item.id,model:"untrusted"}),deps)).status,200);assert.equal(rpcName,"enqueue_atlas_analysis");assert.equal(rpcArgs.p_embedding_model,config.embeddingModel);
 assert.equal((await handleAtlasAI(req({action:"search",query:"x".repeat(17000)}),deps)).status,413);
});
test("Atlas worker: persisted jobs run without a browser and completion uses lease token; private errors stay bounded",async()=>{
 const calls:{url:string;body:any}[]=[];
 const fetcher:typeof fetch=async(input,init)=>{const url=String(input),body=JSON.parse(String(init?.body));calls.push({url,body});if(url.endsWith("claim_atlas_analysis"))return reply({id:"job",token:"lease",ownerId:owner,itemId:item.id,item});if(url.endsWith("responses"))return reply(success);if(url.endsWith("embeddings"))return reply({model:config.embeddingModel,data:[{embedding:[1,0]}]});return reply(true);};
 assert.equal(await runWorkerOnce(env,fetcher),true);assert.equal(calls.at(-1)?.body.p_token,"lease");assert.equal(calls.at(-1)?.body.p_result.caption,"夕方の道");
 calls.length=0;await runWorkerOnce(env,async(input,init)=>{const url=String(input);if(url.endsWith("claim_atlas_analysis"))return reply({id:"job",token:"lease",ownerId:owner,itemId:item.id,item});if(url.endsWith("responses"))throw new Error("private text");calls.push({url,body:JSON.parse(String(init?.body))});return reply(false);});assert.deepEqual(calls[0].body,{p_job:"job",p_token:"lease",p_result:null,p_error:"provider_failed"});
});
test("Atlas worker: private image originals are hash-checked before any provider call",async()=>{
 const bytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=","base64"),sha=createHash("sha256").update(bytes).digest("hex");
 const resource={...item,kind:"resource",originApp:"collect",resourceType:"image",title:"夜景",memo:"青い光",sourceUrl:"https://example.com/photo",url:null,inbox:true,metadata:{title:"",description:""},image:{filename:"test.png",mimeType:"image/png",size:bytes.length,sha256:sha,width:1,height:1}};
 for(const corrupt of [false,true]){
  let providerCalls=0,completion:any,downloadUrl="";
  await runWorkerOnce(env,async(input,init)=>{const url=String(input);if(url.endsWith("claim_atlas_analysis"))return reply({id:"job",token:"lease",ownerId:owner,itemId:item.id,item:resource});
   if(url.includes("/storage/")){downloadUrl=url;return new Response(corrupt?Buffer.alloc(bytes.length):bytes);}
   if(url.endsWith("responses")){providerCalls++;const sent=JSON.parse(String(init?.body));assert.ok(sent.input[0].content.some((v:any)=>v.image_url===`data:image/png;base64,${bytes.toString("base64")}`));return reply(success);}
   if(url.endsWith("embeddings"))return reply({model:config.embeddingModel,data:[{embedding:[1,0]}]});completion=JSON.parse(String(init?.body));return reply(true);
  });
  assert.equal(downloadUrl,`https://example.supabase.co/storage/v1/object/authenticated/personal-tools-private/${owner}/${item.id}/originals/${sha}.png`);assert.equal(providerCalls,corrupt?0:1);assert.equal(completion.p_error,corrupt?"provider_failed":null);
 }
});
test("Atlas evaluation: records require human targets, report hit@k and MRR without claiming unevaluated quality",()=>{
 assert.throws(()=>evaluateAtlas(Array.from({length:25},()=>({query:"路地",expectedItemIds:[],rankedItemIds:[]}))));
 const rows=Array.from({length:20},(_,i)=>({query:`検索${i}`,expectedItemIds:["target"],rankedItemIds:i<10?["target"]:i<15?["other","target"]:[]}));assert.deepEqual(evaluateAtlas(rows),{queries:20,hitAt1:.5,hitAt5:.75,hitAt10:.75,meanReciprocalRank:.625,misses:5});
});
