import {embedText,type AIConfig} from "./ai.ts";
type Client={rpc(name:string,args:Record<string,unknown>):PromiseLike<{data:unknown;error:unknown}>};
type Dependencies={config:()=>AIConfig|null;authenticate:()=>Promise<{id:string;enabled:boolean;client:Client}|null>;embed?:typeof embedText};
const budgets=new Map<string,{at:number;count:number}>();
const reply=(data:unknown,status=200)=>Response.json(data,{status,headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
export async function handleAtlasAI(request:Request,deps:Dependencies):Promise<Response>{
  const config=deps.config();
  if(request.method==="GET")return reply({configured:!!config,model:config?.model??null,embeddingModel:config?.embeddingModel??null});
  const origin=request.headers.get("origin"),host=request.headers.get("host")??new URL(request.url).host;
  try{if(!origin||new URL(origin).host!==host||new URL(origin).protocol!==new URL(request.url).protocol)return reply({error:"この画面から実行してください。"},403);}catch{return reply({error:"送信元を確認できません。"},403);}
  if(request.headers.get("content-type")?.split(";")[0]!=="application/json")return reply({error:"JSONが必要です。"},415);
  if(!config)return reply({error:"AIの接続設定がまだありません。"},503);
  const session=await deps.authenticate();if(!session)return reply({error:"ログインしてください。"},401);
  if(!session.enabled)return reply({error:"先にAI利用の設定を保存してください。"},403);
  if(budgets.size>1000)for(const [id,b] of budgets)if(Date.now()-b.at>60000)budgets.delete(id);
  const budget=budgets.get(session.id);if(budget&&Date.now()-budget.at<60000){if(budget.count>=20)return reply({error:"少し待ってから再度お試しください。"},429);budget.count++;}else budgets.set(session.id,{at:Date.now(),count:1});
  try{
    const reader=request.body?.getReader();if(!reader)return reply({error:"入力がありません。"},400);
    const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>16000)return reply({error:"入力が大きすぎます。"},413);chunks.push(chunk.value);}}finally{await reader.cancel();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const body=JSON.parse(new TextDecoder().decode(bytes));
    if(body.action==="queue"){
      if(typeof body.itemId!=="string"||!/^[0-9a-f-]{36}$/i.test(body.itemId))return reply({error:"記録を選んでください。"},400);
      const result=await session.client.rpc("enqueue_atlas_analysis",{p_item:body.itemId,p_model:config.model,p_embedding_model:config.embeddingModel});
      return result.error?reply({error:"解析を予約できません。同期と除外スペースを確認してください。"},409):reply({jobId:result.data});
    }
    if(body.action!=="search"||typeof body.query!=="string"||!body.query.trim()||body.query.length>500)return reply({error:"検索語は1〜500文字で入力してください。"},400);
    for(const key of ["kind","spaceId","tag","projectId"])if(body[key]!=null&&(typeof body[key]!=="string"||body[key].length>100))return reply({error:"絞り込みを確認してください。"},400);
    if(body.kind&&!['note','sketch','resource'].includes(body.kind)||body.projectId&&!/^[0-9a-f-]{36}$/i.test(body.projectId))return reply({error:"絞り込みを確認してください。"},400);
    const vector=await (deps.embed??embedText)(config,body.query.trim());
    const result=await session.client.rpc("match_atlas_documents",{p_vector:vector,p_model:config.model,p_embedding_model:config.embeddingModel,p_kind:body.kind||null,p_space:body.spaceId||null,p_tag:body.tag||null,p_project:body.projectId||null,p_limit:100});
    if(result.error)return reply({error:"意味検索を完了できません。同期と接続設定を確認してください。"},502);
    return reply({matches:result.data,model:config.model,embeddingModel:config.embeddingModel});
  }catch{return reply({error:"AI処理を完了できませんでした。入力・接続・モデル設定を確認してください。"},502);}
}
