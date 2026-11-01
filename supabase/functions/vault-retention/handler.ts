type Client={rpc:(name:string,args?:Record<string,unknown>)=>PromiseLike<{data:any;error:any}>;storage:{from:(bucket:string)=>{remove:(paths:string[])=>PromiseLike<{error:any}>}}};
const response=(status:number,value:Record<string,unknown>)=>new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
export async function handleRetention(request:Request,client:Client):Promise<Response>{
 if(request.method!=="POST")return response(405,{error:"Method not allowed"});
 const token=request.headers.get("X-Retention-Token")??"";
 if(!/^[a-f0-9]{64}$/.test(token))return response(401,{error:"Unauthorized"});
 const verified=await client.rpc("verify_retention_worker",{p_token:token});
 if(verified.error||verified.data!==true)return response(401,{error:"Unauthorized"});
 const claimed=await client.rpc("claim_vault_file_gc",{p_limit:20});
 if(claimed.error||!Array.isArray(claimed.data))return response(503,{error:"Retry later"});
 let removed=0,failed=0;
 for(const row of claimed.data){
  // Remove actual object bytes via Storage API. SQL only maintains references and retry receipts.
  let success=false;try{success=!(await client.storage.from("personal-tools-vault").remove([row.path])).error;}catch{}
  const completed=await client.rpc("complete_vault_file_gc",{p_owner:row.ownerId,p_path:row.path,p_token:row.token,p_success:success});
  if(success&&!completed.error)removed++;else failed++;
 }
 return response(failed?503:200,{removed,failed});
}
