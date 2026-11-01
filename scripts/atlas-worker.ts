import {pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
import {aiConfig,analyzeItem} from "../apps/atlas/lib/ai.ts";
import type {AtlasItem} from "../packages/core/src/index.ts";
export async function runWorkerOnce(env:Record<string,string|undefined>=process.env,fetcher:typeof fetch=fetch){
 const config=aiConfig(env),url=env.NEXT_PUBLIC_SUPABASE_URL,secret=env.ATLAS_WORKER_SECRET;
 if(!config||!url||!secret)throw new Error("AI models, OPENAI_API_KEY, NEXT_PUBLIC_SUPABASE_URL and ATLAS_WORKER_SECRET are required");
 const target=new URL(url);if(target.username||target.password||target.pathname!=="/"||target.search||target.hash||target.protocol!=="https:"&&!['localhost','127.0.0.1','[::1]'].includes(target.hostname))throw new Error("Invalid Supabase origin");
 const headers={apikey:secret,Authorization:`Bearer ${secret}`,"Content-Type":"application/json"};
 async function rpc(name:string,args:unknown){const response=await fetcher(`${target.origin}/rest/v1/rpc/${name}`,{method:"POST",headers,body:JSON.stringify(args),signal:AbortSignal.timeout(15000),redirect:"error"});if(!response.ok)throw new Error("Worker database request failed");return response.json();}
 const job=await rpc("claim_atlas_analysis",{p_model:config.model,p_embedding_model:config.embeddingModel});if(!job)return false;
 try{
  const item=job.item as AtlasItem;let image:{base64:string;mimeType:string}|null=null;
  if(item.kind==="resource"&&item.image){
   const original=item.image,ext={"image/png":"png","image/jpeg":"jpg","image/gif":"gif","image/webp":"webp"}[original.mimeType];
   if(!ext||original.size>20971520)throw new Error("Invalid image");
   const path=`${job.ownerId}/${item.id}/originals/${original.sha256}.${ext}`;
   const response=await fetcher(`${target.origin}/storage/v1/object/authenticated/personal-tools-private/${path}`,{headers:{apikey:secret,Authorization:`Bearer ${secret}`},signal:AbortSignal.timeout(30000),redirect:"error"});
   if(!response.ok)throw new Error("Original not available yet");
   const reader=response.body?.getReader();if(!reader)throw new Error("Image missing");const chunks:Uint8Array[]=[];let size=0;
   try{for(;;){const v=await reader.read();if(v.done)break;size+=v.value.length;if(size>original.size)throw new Error("Image size mismatch");chunks.push(v.value);}}finally{await reader.cancel();}
   const bytes=Buffer.concat(chunks);if(bytes.length!==original.size||createHash("sha256").update(bytes).digest("hex")!==original.sha256)throw new Error("Image integrity mismatch");
   image={base64:bytes.toString("base64"),mimeType:original.mimeType};
  }
  const result=await analyzeItem(config,item,image,fetcher);
  await rpc("finish_atlas_analysis",{p_job:job.id,p_token:job.token,p_result:result,p_error:null});
 }catch{
  // Persist a bounded error code only. Never echo source text, provider errors or keys.
  await rpc("finish_atlas_analysis",{p_job:job.id,p_token:job.token,p_result:null,p_error:"provider_failed"});
 }
 return true;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 throw new Error("暗号化金庫では外部AIワーカーを実行できません。");
 let stopping=false;process.once("SIGINT",()=>{stopping=true;});process.once("SIGTERM",()=>{stopping=true;});
 while(!stopping){try{const worked=await runWorkerOnce();if(process.argv.includes("--once"))break;if(worked)continue;}catch{console.error("Atlas worker: 接続・モデル設定を確認してください。");if(process.argv.includes("--once")){process.exitCode=1;break;}}await new Promise(resolve=>setTimeout(resolve,5000));}
}
