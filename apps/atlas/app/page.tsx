"use client";
import {GoogleSignInButton} from "@personal-tools/auth/google";
import {VaultRetentionSettings} from "@personal-tools/auth/vault";
import {Modal as SharedModal,ToolEntrances,SuiteShell,SearchField,SectionHeading,RecordGrid,SaveState,useDraftNavigation,useSuiteOrganization} from "@personal-tools/ui";
import {encryptBackup,flushVaultDrafts} from "@personal-tools/api-client";
import {useEffect,useRef,useState,type ReactNode} from "react";
import {atlasTitle,atlasText,originalHref,searchAtlas,relatedItems,RELATION_TYPES,RELATION_NAMES,type AtlasItem,type AtlasProject,type RelationType,type ItemLabels} from "@personal-tools/core";
import {downloadEncryptedResourceOriginal as downloadResourceOriginal,type RecallRepository} from "@personal-tools/api-client";
import {getBrowserAuthClient} from "@personal-tools/auth/browser";
import {usePersonalToolsCloud,type CloudSnapshot} from "@personal-tools/auth/react";

const EMPTY:CloudSnapshot={notes:[],spaces:[],sketches:[],resources:[],relations:[],projects:[],labels:[]};
const KINDS:Record<string,string>={note:"メモ",sketch:"スケッチ",resource:"資料"};
const DATE=(v:string)=>new Intl.DateTimeFormat("ja-JP",{month:"short",day:"numeric"}).format(new Date(v));
function Modal({title,close,children}:{title:string;close:()=>void;children:ReactNode}){return <SharedModal title={title} onClose={close}>{children}</SharedModal>; }
function TagEditor({labels,save,busy}:{labels:ItemLabels|undefined;save:(tags:string[])=>void;busy:boolean}){
 const [text,setText]=useState(labels?.tags.join("、")??"");
 return <form onSubmit={e=>{e.preventDefault();save(text.split(/[,、\n]/u).map(t=>t.trim()).filter(Boolean));}}><label>自分のタグ<input value={text} onChange={e=>setText(e.target.value)} placeholder="夜景、青い光、構図"/></label><button disabled={busy}>タグを保存</button></form>;
}
export default function Atlas(){
 const repo=useRef<RecallRepository|null>(null),epoch=useRef(0);
 const [data,setData]=useState<CloudSnapshot>(EMPTY),[ready,setReady]=useState(false),[selectedId,setSelectedId]=useState("");
 const [query,setQuery]=useState(""),[kind,setKind]=useState(""),[spaceId,setSpaceId]=useState(""),[tag,setTag]=useState("");
 const [error,setError]=useState(""),[notice,setNotice]=useState(""),[busy,setBusy]=useState(false),[settings,setSettings]=useState(false),[email,setEmail]=useState("");
 const [spaceName,setSpaceName]=useState(""),[spaceDialog,setSpaceDialog]=useState(false);
 const [relationTarget,setRelationTarget]=useState(""),[relationType,setRelationType]=useState<RelationType>("related_to");
 const [preview,setPreview]=useState(""),[previewError,setPreviewError]=useState("");
 function fail(value:unknown){setError(value instanceof Error?value.message:"処理を完了できませんでした。");}
 function context(){const repository=repo.current,at=epoch.current;return {repository,current:()=>at===epoch.current&&repo.current===repository};}
 const cloud=usePersonalToolsCloud({
  reset(){epoch.current++;repo.current=null;setData(EMPTY);setReady(false);setSelectedId("");setQuery("");setKind("");setSpaceId("");setTag("");setPreview("");setPreviewError("");setError("");setNotice("");setBusy(false);setEmail("");setSettings(false);setRelationTarget("");},
  ready(repository,snapshot){repo.current=repository;setData(snapshot);setReady(true);setSelectedId(new URL(window.location.href).searchParams.get("item")??"");},snapshot:setData,failure:fail,
 },{app:"atlas"});
 const organization=useSuiteOrganization({repository:ready?repo.current:null,projects:data.projects,spaces:data.spaces,beforeChange:flushVaultDrafts,changed:()=>{void cloud.refresh();void cloud.runSync(false);},failure:fail});
 const {projectId,setProjectId}=organization;
 const ownerId=cloud.identity.mode==="account"?cloud.identity.userId:null;
 const items:AtlasItem[]=[...data.notes,...data.sketches,...data.resources];
 const selected=items.find(i=>i.id===selectedId&&i.ownerId===ownerId&&!i.deletedAt);
 const selectedLabels=data.labels.find(l=>l.id===selectedId&&!l.deletedAt);
 const projects=data.projects.filter(p=>!p.deletedAt&&p.ownerId===ownerId);
 const tags=[...new Set(data.labels.filter(l=>!l.deletedAt&&l.ownerId===ownerId).flatMap(l=>l.tags))].sort((a,b)=>a.localeCompare(b,"ja"));
 const lexical=searchAtlas(items,data.labels,data.projects,{query,kind,spaceId,tag,projectId},ownerId);
 const shown=lexical;
 const related=selected?relatedItems(selected,items,data.relations):[];
 const status=!ready?"読み込み中…":cloud.identity.mode==="device"?"端末内モード":cloud.syncStatus.phase==="syncing"?"同期中…":cloud.syncStatus.phase==="error"?"同期の確認が必要":cloud.conflicts.length?`競合 ${cloud.conflicts.length}件`:cloud.syncStatus.pending?`同期待ち ${cloud.syncStatus.pending}件`:"クラウド同期済み";
 async function perform(work:(repository:RecallRepository)=>Promise<unknown>,message="保存しました"){
  const guard=context();if(!guard.repository)return;setBusy(true);setError("");
  try{await work(guard.repository);if(guard.current()){await cloud.refresh();setNotice(message);}}catch(e){if(guard.current())fail(e);}finally{if(guard.current())setBusy(false);}
 }

 useEffect(()=>{setRelationTarget("");},[selectedId]);
 useEffect(()=>{
  if(!ready)return;
  if(process.env.NODE_ENV==="production"&&"serviceWorker" in navigator)void navigator.serviceWorker.register("/atlas/sw.js",{scope:"/atlas/"}).catch(()=>{});
 },[ready]);
 useEffect(()=>{
  setPreview("");setPreviewError("");if(!selected||selected.kind!=="resource"||!selected.image)return;
  const guard=context(),resource=selected;let active=true,url="";
  void (async()=>{try{let blob=await guard.repository?.getResourceFile(resource.id);if(!blob&&ownerId){const client=getBrowserAuthClient();if(client&&guard.repository)blob=await downloadResourceOriginal(client,ownerId,resource,{isCurrent:guard.current});}if(blob&&active&&guard.current()){url=URL.createObjectURL(blob);setPreview(url);}else if(active&&guard.current())setPreviewError("画像原本はCollectで同期してから開いてください。");}catch{if(active&&guard.current())setPreviewError("画像を取得できません。Collectで原本の同期を確認してください。");}})();
  return()=>{active=false;if(url)URL.revokeObjectURL(url);};
 },[selectedId,selected?.kind==="resource"?selected.image?.sha256:null,ownerId]);
 function pick(id:string){setSelectedId(id);const url=new URL(window.location.href);url.searchParams.set("item",id);history.replaceState(null,"",url);}
 function exportBackup(){void perform(async repository=>{const backup=await repository.exportAtlasBackup(),url=URL.createObjectURL(new Blob([await encryptBackup(backup)],{type:"application/json"})),anchor=document.createElement("a");anchor.href=url;anchor.download=`atlas-${new Date().toISOString().slice(0,10)}.json`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),2000);},"Atlasのバックアップを書き出しました");}
 const navigation=useDraftNavigation({blocked:!ready||busy,failure:fail,prepare:async()=>!!repo.current});
 return <SuiteShell tool="atlas" title="Atlasホーム" status={status} warning={cloud.syncStatus.phase==="error"||!!cloud.conflicts.length} navigation={navigation}
   search={<SearchField label="記録を横断検索" value={query} onChange={setQuery} placeholder="本文・タイトル・タグを検索"/>}
   views={[{id:"all",label:"すべての記録",count:items.filter(item=>!item.deletedAt).length}]} view="all" onViewChange={()=>{setProjectId("");setSpaceId("");}}
   spaces={data.spaces.map(space=>({...space,count:items.filter(item=>!item.deletedAt&&item.spaceIds.includes(space.id)).length}))} space={spaceId} onSpaceChange={setSpaceId} onAddSpace={()=>setSpaceDialog(true)} onSettings={()=>setSettings(true)}
   sidebarExtra={organization.sidebar} projectFilter={organization.filter}>
   <ToolEntrances/>
<div className="atlas-filters"><select aria-label="種類で絞り込み" value={kind} onChange={e=>setKind(e.target.value)}><option value="">すべての種類</option>{Object.entries(KINDS).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select><select aria-label="タグで絞り込み" value={tag} onChange={e=>setTag(e.target.value)}><option value="">すべてのタグ</option>{tags.map(t=><option key={t}>{t}</option>)}</select><span className="muted">暗号化金庫 · 端末内検索</span></div>
   {error&&<div className="message error" role="alert">{error}<button onClick={()=>setError("")} aria-label="エラーを閉じる">×</button></div>}{notice&&<div className="message" role="status">{notice}<button onClick={()=>setNotice("")} aria-label="通知を閉じる">×</button></div>}
   <div className="atlas-workspace"><section className="results"><SectionHeading title={projects.find(project=>project.id===projectId)?.name??"すべての記録"} count={shown.length}><button className="button" disabled={!ready} onClick={()=>organization.createFor()}>＋ プロジェクト</button></SectionHeading>
    {!ready?<div className="empty">記録を読み込んでいます…</div>:!shown.length?<div className="empty"><span className="empty-symbol">⌘</span><h3>{items.some(i=>!i.deletedAt)?"記録が見つかりませんでした":"記録がありません"}</h3><p>{items.some(i=>!i.deletedAt)?"ことばや絞り込みを変えて、もう一度探してみてください。":"上の入口からメモ、画像、スケッチを追加できます。"}</p><a href="/recall/">Recallでメモを書く ↗</a></div>:<RecordGrid>{shown.map(item=><button key={item.id} className={`item-card ${selectedId===item.id?"selected":""} kind-${item.kind}`} onClick={()=>pick(item.id)}><div className="card-top"><span className="kind-label">{item.kind==="note"?"≡":item.kind==="sketch"?"〰":"▧"} {KINDS[item.kind]}</span><time>{DATE(item.updatedAt)}</time></div><h3>{atlasTitle(item)}</h3><p>{atlasText(item).slice(0,200)||"スケッチの原本を開いてみる"}</p><div className="card-footer">{item.spaceIds.slice(0,2).map(id=><span key={id}>{data.spaces.find(s=>s.id===id)?.name}</span>)}{!item.spaceIds.length&&<span>スペース未指定</span>}<em>{item.originApp} ↗</em></div></button>)}</RecordGrid>}
   </section><aside className="detail" aria-label="記録の詳細">{!selected?<div className="detail-empty"><span>↖</span><h3>記録の詳細</h3><p>記録を選ぶと、原本や関連、<br/>プロジェクトが見られます。</p></div>:<><div className="detail-top"><span className="eyebrow">{selected.originApp.toUpperCase()}</span><button className="plain" aria-label="詳細を閉じる" onClick={()=>setSelectedId("")}>×</button></div><h2>{atlasTitle(selected)}</h2><a className="original-link" href={originalHref(selected)}>原本を{selected.originApp}で開く ↗</a>{preview&&<img className="original-image" src={preview} alt={atlasTitle(selected)}/>}<p className="muted">{previewError}</p>{selected.kind==="sketch"&&<svg className="sketch-preview" viewBox="0 0 1200 800" aria-label="スケッチのプレビュー"><rect width="1200" height="800" fill="white"/>{selected.strokes.map(s=><polyline key={s.id} points={s.points.map(p=>`${p.x},${p.y}`).join(" ")} fill="none" stroke={s.tool==="eraser"?"white":s.color} strokeWidth={s.width} strokeLinecap="round" strokeLinejoin="round"/>)}</svg>}<p className="detail-text">{atlasText(selected).slice(0,4000)}</p>
    <section><h3>タグ</h3><TagEditor key={`${selectedId}:${selectedLabels?.localRevision??0}`} labels={selectedLabels} busy={busy} save={tags=>void perform(r=>r.saveLabels(selected.id,tags,selectedLabels?.localRevision))}/></section>
    <section><h3>プロジェクトにまとめる</h3>{organization.itemButton(selected.id)}<button className="plain" onClick={()=>organization.createFor(selected.id)}>＋ 新しいプロジェクト</button></section>
    <section><h3>この記録とのつながり</h3>{related.map(({relation,item,label})=><div className="relation" key={relation.id}><button className="plain" onClick={()=>pick(item.id)}><small>{label}</small><span>{atlasTitle(item)} ↗</span></button><button className="plain" disabled={busy} aria-label={`${atlasTitle(item)}との関連を解除`} onClick={()=>void perform(r=>r.deleteRelation(relation.id,relation.localRevision))}>×</button></div>)}{!related.length&&<p className="muted">まだつながりはありません。</p>}<form onSubmit={e=>{e.preventDefault();void perform(r=>r.saveRelation({fromItemId:selected.id,toItemId:relationTarget,type:relationType}));}}><label>この記録は<select aria-label="関係の種類" value={relationType} onChange={e=>setRelationType(e.target.value as RelationType)}>{RELATION_TYPES.map(t=><option key={t} value={t}>{RELATION_NAMES[t][0]}</option>)}</select></label><label>相手の記録<select aria-label="関連付ける記録" value={relationTarget} onChange={e=>setRelationTarget(e.target.value)} required><option value="">記録を選ぶ</option>{items.filter(i=>i.id!==selected.id&&!i.deletedAt&&i.ownerId===ownerId).map(i=><option key={i.id} value={i.id}>{KINDS[i.kind]} · {atlasTitle(i).slice(0,50)}</option>)}</select></label><button disabled={busy||!relationTarget}>つながりを追加</button></form></section>

   </>}</aside></div><footer className="page-footer"><button className="plain" onClick={()=>setSettings(true)}>保存とバックアップ</button></footer>

  {spaceDialog&&<Modal title="新しいスペース" close={()=>setSpaceDialog(false)}><form onSubmit={event=>{event.preventDefault();void perform(async repository=>{await repository.createSpace(spaceName);setSpaceName("");setSpaceDialog(false);},"スペースを追加しました");}}><label>スペース名<input autoFocus value={spaceName} maxLength={40} required onChange={event=>setSpaceName(event.target.value)}/></label><button className="button primary" disabled={busy||!spaceName.trim()}>スペースを作る</button></form></Modal>}
  {settings&&<Modal title="保存とアカウント" close={()=>setSettings(false)}><VaultRetentionSettings/><hr/>{organization.spaceSettings}<hr/><p>{status}</p><p className="muted">端末内データとアカウントのデータは別の保存先です。原本は各ツールからバックアップできます。</p>{cloud.user?<><p>{cloud.user.email}</p><div className="row"><button onClick={()=>void cloud.runSync()}>今すぐ同期</button><button onClick={()=>void cloud.switchWorkspace(ownerId?"device":"account")}>{ownerId?"端末内を開く":"アカウントを開く"}</button><button onClick={()=>void cloud.signOut()}>全ツールからログアウト</button></div></>:cloud.configured?<><GoogleSignInButton disabled={cloud.authBusy}/><details style={{marginTop:16}}><summary>メールでログイン</summary><form onSubmit={e=>{e.preventDefault();void cloud.signIn(email);}}><label>メールアドレス<input type="email" value={email} onChange={e=>setEmail(e.target.value)} required autoComplete="email"/></label><button disabled={cloud.authBusy}>ログインメールを送る</button><p className="muted">届いたリンクをこのブラウザで開き、RecallからAtlasへ戻ってください。</p></form></details></>:<p className="muted">クラウド接続は未設定です。</p>}<p className="muted">{cloud.authMessage}</p><h3>整理情報のバックアップ</h3><p className="muted">プロジェクト・タグ・関連と原本のIDを書き出します。原本・画像は各ツールでも書き出してください。</p><button disabled={busy} onClick={exportBackup}>Atlasの暗号化バックアップを書き出す</button>{cloud.conflicts.map(c=><section key={c.id}><h3>変更が競合しています</h3><p className="muted">保存内容を確認して選んでください。プロジェクトは別の版、タグ・関係は端末の変更を再適用します。</p><details><summary>両方の版を見る</summary><pre>{JSON.stringify({端末:c.local,クラウド:c.remote},null,2)}</pre></details><div className="row"><button disabled={busy} onClick={()=>void perform(()=>cloud.resolveConflict(c.id,"keep_both"))}>端末の変更も残す</button><button disabled={busy} onClick={()=>void perform(()=>cloud.resolveConflict(c.id,"keep_remote"))}>クラウドの版を使う</button></div></section>)}</Modal>}
 {organization.dialogs}</SuiteShell>;
}
