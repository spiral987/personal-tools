import "fake-indexeddb/auto";
import test,{before,after,type TestContext} from "node:test";
import assert from "node:assert/strict";
import {openRecallRepository,openAccountRecallRepository,createSyncEngine,createSupabaseSyncTransport,type AccountRecallRepository} from "../packages/api-client/src/index.ts";
import {searchAtlas,relatedItems,originalHref,parseProjectFields,parseTags,RELATION_TYPES,type AtlasProject,type AtlasItem} from "../packages/core/src/index.ts";
import {createTestDatabase} from "./helpers/database.ts";
let db:Awaited<ReturnType<typeof createTestDatabase>>;
before(async()=>{db=await createTestDatabase();});after(async()=>{await db.close();});
async function device(t:TestContext,user?:string){const repo=user?await openAccountRecallRepository(user,{name:crypto.randomUUID()}):await openRecallRepository(crypto.randomUUID());t.after(()=>repo.close());return repo;}
async function sync(repo:AccountRecallRepository){const transport=createSupabaseSyncTransport({async rpc(name,args){try{return {data:name==="apply_sync_operation"?await db.apply(repo.ownerId,args.p_operation):await db.pullAtlas(repo.ownerId,String(args.p_cursor),Number(args.p_limit)),error:null};}catch(e){return {data:null,error:{message:String(e)}};}}},repo.ownerId),engine=createSyncEngine(repo,transport);try{const status=await engine.run();assert.notEqual(status.phase,"error",status.error);return status;}finally{engine.stop();}}
const project=(name="短編制作",itemIds:string[]=[]):Pick<AtlasProject,"name"|"description"|"status"|"dueDate"|"itemIds">=>({name,description:"制作の資料を集める",status:"active",dueDate:"2026-12-01",itemIds});
async function corpus(t:TestContext,user?:string){const repo=await device(t,user);const note=await repo.saveNote({body:"青い夕方の路地 ＡＢＣ",spaceIds:["daily"]}),sketch=await repo.saveSketch({title:"俯瞰の人物構図",strokes:[],spaceIds:["creative"]}),resource=await repo.saveResource({resourceType:"link",url:"https://example.com/night",sourceUrl:"",title:"夜景の資料",memo:"青い光の看板",spaceIds:[],inbox:true,image:null});return {repo,note,sketch,resource};}

test("Atlas local: Japanese AND search spans original kinds, spaces, confirmed tags and projects without copies",async t=>{
 const {repo,note,sketch,resource}=await corpus(t);await repo.saveLabels(resource.id,["都市","青い光"]);const p=await repo.saveProject(project("制作",[note.id,resource.id]));const s=await repo.snapshot(),items=[...s.notes,...s.sketches,...s.resources];
 assert.deepEqual(searchAtlas(items,s.labels,s.projects,{query:"青い ABC"},null).map(i=>i.id),[note.id]);assert.deepEqual(searchAtlas(items,s.labels,s.projects,{kind:"sketch"},null).map(i=>i.id),[sketch.id]);
 assert.deepEqual(searchAtlas(items,s.labels,s.projects,{tag:"都市",projectId:p.id},null).map(i=>i.id),[resource.id]);assert.equal(searchAtlas(items,s.labels,s.projects,{spaceId:"daily"},null).length,1);assert.equal(searchAtlas(items,s.labels,s.projects,{projectId:"missing"},null).length,0);
 assert.equal(searchAtlas(items,s.labels,s.projects,{},crypto.randomUUID()).length,0);for(const item of items)assert.equal(originalHref(item),`/${item.originApp}/?item=${item.id}`);
});
test("Atlas local: every relation supports incoming display; related_to is symmetric and deterministic",async t=>{
 const {repo,note,sketch,resource}=await corpus(t);
 for(const type of RELATION_TYPES)await repo.saveRelation({fromItemId:sketch.id,toItemId:type==="inspired_by"?resource.id:note.id,type});
 const first=await repo.saveRelation({fromItemId:note.id,toItemId:sketch.id,type:"related_to"}),again=await repo.saveRelation({fromItemId:sketch.id,toItemId:note.id,type:"related_to"});assert.equal(first.id,again.id);
 let s=await repo.snapshot();assert.equal(s.relations.length,5);assert.match(relatedItems(resource,[note,sketch,resource],s.relations)[0].label,/この記録に着想/);
 await repo.updateSketch(sketch.id,{deletedAt:new Date().toISOString()},sketch.localRevision);s=await repo.snapshot();assert.equal(relatedItems(note,[note,...s.sketches,resource],s.relations).length,0);assert.equal(s.notes.length+s.sketches.length+s.resources.length,3);
});
test("Atlas local: revisions, malformed memberships and tag limits preserve existing data",async t=>{
 const {repo,note}=await corpus(t);const p=await repo.saveProject(project("制作",[note.id]));await repo.saveProject({...p,name:"更新"},p.localRevision);await assert.rejects(repo.saveProject({...p,name:"古い版"},p.localRevision));
 await assert.rejects(repo.saveProject(project("他の原本",[crypto.randomUUID()])));assert.equal((await repo.snapshot()).projects.length,1);
 const labels=await repo.saveLabels(note.id,["ＡＢＣ","abc","都市"]);assert.deepEqual(labels.tags,["abc","都市"]);await assert.rejects(repo.saveLabels(note.id,["古いタグ"]));
 for(const input of [project(""),{...project(),dueDate:"2026-02-30"},{...project(),itemIds:[null]}])assert.throws(()=>parseProjectFields(input));assert.throws(()=>parseTags([" "]));assert.throws(()=>parseTags(Array(51).fill("tag")));
});
test("Atlas sync: independent caches exchange general relations, projects, memberships, tags and tombstones",async t=>{
 const owner=await db.addUser(),{repo,note,sketch,resource}=await corpus(t,owner),a=repo as AccountRecallRepository,b=await device(t,owner) as AccountRecallRepository;
 await a.saveRelation({fromItemId:note.id,toItemId:resource.id,type:"supports"});const p=await a.saveProject(project("短編",[sketch.id,resource.id]));await a.saveLabels(resource.id,["夜景"]);await sync(a);await sync(b);
 let s=await b.snapshot();assert.equal(s.projects[0].name,"短編");assert.deepEqual(s.labels[0].tags,["夜景"]);assert.equal(s.relations[0].type,"supports");
 const rp=s.projects[0];await b.saveProject({...rp,status:"done",deletedAt:new Date().toISOString()},rp.localRevision);await sync(b);await sync(a);s=await a.snapshot();assert.ok(s.projects.find(x=>x.id===p.id)?.deletedAt);assert.equal(s.resources.length,1);
});
test("Atlas sync: stale project edits retain both versions and new stream hides kinds from legacy clients",async t=>{
 const owner=await db.addUser(),a=await device(t,owner) as AccountRecallRepository,b=await device(t,owner) as AccountRecallRepository;await a.saveProject(project());await sync(a);await sync(b);
 const pa=(await a.snapshot()).projects[0],pb=(await b.snapshot()).projects[0];await a.saveProject({...pa,name:"A版"},pa.localRevision);await b.saveProject({...pb,name:"B版"},pb.localRevision);await sync(a);assert.equal((await sync(b)).phase,"conflict");
 const conflict=(await b.getSyncState()).conflicts[0];await b.resolveConflict(conflict.id,"keep_both");await sync(b);assert.deepEqual(new Set((await b.snapshot()).projects.map(p=>p.name)),new Set(["A版","B版"]));
 for(const stream of [await db.pull(owner),await db.pullSuite(owner),await db.pullTools(owner)])assert.ok(stream.changes.every(c=>!["project","labels"].includes(c.entity)));
});
test("Atlas RLS: owner checks precede mutations and no browser can write tables or lease AI jobs",async t=>{
 const owner=await db.addUser(),other=await db.addUser(),{repo,note}=await corpus(t,owner);await sync(repo as AccountRecallRepository);const p=await repo.saveProject(project("秘密",[note.id]));await repo.saveLabels(note.id,["秘密"]);await sync(repo as AccountRecallRepository);
 for(const table of ["projects","project_items","item_labels","search_documents","analysis_jobs","atlas_ai_settings"])assert.equal((await db.queryAs(other,`select * from public.${table}`)).rows.length,0);
 const op=(payload:unknown,kind:string,id:string)=>({id:crypto.randomUUID(),kind,entityId:id,baseRevision:null,payload});
 await assert.rejects(db.apply(other,op({...p,id:crypto.randomUUID()},"put_project",crypto.randomUUID())));
 const id=crypto.randomUUID();await assert.rejects(db.apply(other,op({...p,id,itemIds:[note.id]},"put_project",id)),/not found in your account/);
 await assert.rejects(db.queryAs(owner,"select public.claim_atlas_analysis('m','e')"),/permission denied/);await assert.rejects(db.queryAs(owner,"update public.projects set name='hacked'"),/permission denied/);
 await assert.rejects(db.queryAs(null,"select public.pull_atlas_changes('0',100)"),/permission denied/);
});

async function rpc(user:string,name:string,args:unknown[]=[]){const result=await db.queryAs(user,`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) as result`,args);return result.rows[0].result as any;}
async function worker(name:string,args:unknown[]=[]){return db.db.transaction(async tx=>{await tx.exec("set local role service_role");const result=await tx.query(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) as result`,args);return result.rows[0].result as any;});}
const analysis=(embedding=[1,0])=>({caption:"青い夕方の路地",ocr:"看板",suggestions:["青い光"],text:"青い光の路地",embedding});
async function enable(owner:string,excluded:string[]=[]){return rpc(owner,"configure_atlas_ai",[true,excluded]);}
async function queue(owner:string,id:string,model="m",embedding="e"){return rpc(owner,"enqueue_atlas_analysis",[id,model,embedding]);}
async function index(owner:string,id:string,vector=[1,0],model="m",embedding="e"){await queue(owner,id,model,embedding);const job=await worker("claim_atlas_analysis",[model,embedding]);assert.equal(job.itemId,id);assert.equal(await worker("finish_atlas_analysis",[job.id,job.token,JSON.stringify(analysis(vector)),null]),true);}
async function match(owner:string,vector=[1,0],kind:string|null=null,space:string|null=null,tag:string|null=null,project:string|null=null,limit=1,model="m",embedding="e"){const r=await db.queryAs(owner,"select * from public.match_atlas_documents($1,$2,$3,$4,$5,$6,$7,$8)",[vector,model,embedding,kind,space,tag,project,limit]);return r.rows;}
test("Atlas AI: explicit consent and excluded spaces gate durable jobs; duplicate enqueue preserves one job",async t=>{
 const owner=await db.addUser(),{repo,note,resource}=await corpus(t,owner);await sync(repo as AccountRecallRepository);await assert.rejects(queue(owner,note.id),/consent/);await enable(owner,["daily"]);await assert.rejects(queue(owner,note.id),/Excluded/);
 const id=await queue(owner,resource.id);assert.equal(await queue(owner,resource.id),id);const j=await worker("claim_atlas_analysis",["m","e"]);assert.equal(j.id,id);assert.equal(j.item.ownerId,owner);assert.equal(await worker("claim_atlas_analysis",["m","e"]),null);
 assert.equal(await worker("finish_atlas_analysis",[j.id,crypto.randomUUID(),JSON.stringify(analysis()),null]),false);assert.equal(await worker("finish_atlas_analysis",[j.id,j.token,JSON.stringify(analysis()),null]),true);
 assert.equal((await match(owner)).length,1);await rpc(owner,"configure_atlas_ai",[false,[]]);assert.equal((await match(owner)).length,0);
});
test("Atlas AI: revision changes, reclassification, deletion and model changes invalidate old results and leased replies",async t=>{
 const owner=await db.addUser(),{repo,note}=await corpus(t,owner),a=repo as AccountRecallRepository;await sync(a);await enable(owner);await index(owner,note.id);await a.saveNote({...note,spaceIds:["creative"]},note.localRevision);await sync(a);assert.equal((await match(owner)).length,0);
 await queue(owner,note.id);const job=await worker("claim_atlas_analysis",["m","e"]);let latest=(await a.snapshot()).notes[0];await a.saveNote({...latest,deletedAt:new Date().toISOString()},latest.localRevision);await sync(a);assert.equal(await worker("finish_atlas_analysis",[job.id,job.token,JSON.stringify(analysis()),null]),false);
 latest=(await a.snapshot()).notes[0];await a.saveNote({...latest,deletedAt:null},latest.localRevision);await sync(a);assert.equal((await match(owner)).length,0);
 await index(owner,note.id);await queue(owner,note.id,"m2","e2");assert.equal((await match(owner)).length,0);assert.equal(await worker("claim_atlas_analysis",["m","e"]),null);
});
test("Atlas AI: owner, space, kind, tag and project apply before exact ranking and LIMIT; models/dimensions never mix",async t=>{
 const a=await db.addUser(),b=await db.addUser(),first=await corpus(t,a),second=await corpus(t,b);await first.repo.saveLabels(first.note.id,["目的"]);const p=await first.repo.saveProject(project("対象",[first.note.id]));await sync(first.repo as AccountRecallRepository);await sync(second.repo as AccountRecallRepository);await enable(a);await enable(b);
 await index(a,first.resource.id,[1,0]);await index(a,first.note.id,[0.8,0.2]);await index(b,second.note.id,[1,0]);
 for(const filters of [["note",null,null,null],[null,"daily",null,null],[null,null,"目的",null],[null,null,null,p.id]]){const rows=await match(a,[1,0],...filters as [string|null,string|null,string|null,string|null]);assert.equal(rows.length,1);assert.equal(rows[0].item_id,first.note.id);}
 assert.equal((await match(a,[1,0,0])).length,0);assert.equal((await match(a,[1,0],null,null,null,null,10,"different","e")).length,0);assert.equal((await match(a,[1,0],null,null,null,p.id,10))[0].item_id,first.note.id);
 await assert.rejects(match(a,[0,0]),/Invalid query vector/);await enable(a,["daily"]);assert.equal((await match(a,[1,0],"note")).length,0);
});
test("Atlas AI: retry backoff, expiring leases and maximum attempts survive worker restarts",async t=>{
 const owner=await db.addUser(),{repo,note}=await corpus(t,owner);await sync(repo as AccountRecallRepository);await enable(owner);await queue(owner,note.id);let j=await worker("claim_atlas_analysis",["m","e"]);await worker("finish_atlas_analysis",[j.id,j.token,null,"private provider error"]);assert.equal(await worker("claim_atlas_analysis",["m","e"]),null);
 await db.db.query("update public.analysis_jobs set next_retry_at=now()-interval '1 second' where id=$1",[j.id]);j=await worker("claim_atlas_analysis",["m","e"]);await db.db.query("update public.analysis_jobs set lease_until=now()-interval '1 second' where id=$1",[j.id]);const last=await worker("claim_atlas_analysis",["m","e"]);assert.notEqual(last.token,j.token);await worker("finish_atlas_analysis",[last.id,last.token,null,"failed"]);await db.db.query("update public.analysis_jobs set next_retry_at=now()-interval '1 second' where id=$1",[last.id]);assert.equal(await worker("claim_atlas_analysis",["m","e"]),null);
 assert.equal((await db.queryAs(owner,"select error_code from public.analysis_jobs where id=$1",[j.id])).rows[0].error_code,"provider_failed");
});
