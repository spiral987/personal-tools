"use client";
import {encryptBackup,decryptBackup,beforeVaultLock} from "@personal-tools/api-client";

import {useCallback,useEffect,useRef,useState} from "react";
import {matchesQuery,noteTitle,type Note,type Space,type Sketch,type ItemRelation} from "@personal-tools/core";
import {type RecallRepository} from "@personal-tools/api-client";
import {Button,RecallMark} from "@personal-tools/ui";
import {useRecallCloud} from "./use-recall-cloud";
import {CloudSettings} from "./cloud-settings";
import {AtlasRequestsSettings,useAtlasRequestSharing} from "./atlas-requests-sharing";

type IconName="search"|"plus"|"star"|"clock"|"arrow"|"more"|"edit"|"trash"|"close"|"download"|"upload"|"check"|"restore"|"grid";
function Icon({name,size=18}:{name:IconName;size?:number}) {
  const paths:Record<IconName,React.ReactNode>={
    search:<><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></>,
    plus:<path d="M12 5v14M5 12h14"/>,star:<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/>,
    clock:<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,arrow:<path d="M5 12h14m-5-5 5 5-5 5"/>,
    more:<><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
    edit:<><path d="m16 3 5 5-12 12-6 1 1-6Z"/><path d="m13 6 5 5"/></>,
    trash:<><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/></>,
    close:<path d="m6 6 12 12M6 18 18 6"/>,download:<><path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/></>,
    upload:<><path d="M12 16V4m-5 5 5-5 5 5M4 17v4h16v-4"/></>,check:<path d="m5 12 4 4L19 6"/>,
    restore:<><path d="M4 10a8 8 0 1 1 0 5M4 4v6h6M12 8v5l3 2"/></>,
    grid:<><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
const dayLabel=(date:string)=>{
  const day=new Date(date),today=new Date(),yesterday=new Date();yesterday.setDate(today.getDate()-1);
  return day.toDateString()===today.toDateString()?"今日":day.toDateString()===yesterday.toDateString()?"昨日":new Intl.DateTimeFormat("ja-JP",{month:"long",day:"numeric",weekday:"short"}).format(day);
};
const timeLabel=(date:string)=>new Intl.DateTimeFormat("ja-JP",{hour:"2-digit",minute:"2-digit"}).format(new Date(date));

export default function Recall() {
  const repo=useRef<RecallRepository|null>(null), composer=useRef<HTMLTextAreaElement>(null), fileInput=useRef<HTMLInputElement>(null), modalRef=useRef<HTMLElement>(null);
  const [notes,setNotes]=useState<Note[]>([]),[spaces,setSpaces]=useState<Space[]>([]),[sketches,setSketches]=useState<Sketch[]>([]),[relations,setRelations]=useState<ItemRelation[]>([]);
  const openedItem=useRef<string|null>(null);
  const [ready,setReady]=useState(false),[body,setBody]=useState(""),[draftSpaces,setDraftSpaces]=useState<string[]>([]);
  const [view,setView]=useState("all"),[query,setQuery]=useState(""),[saving,setSaving]=useState(false);
  const [error,setError]=useState(""),[notice,setNotice]=useState(""),[draftStatus,setDraftStatus]=useState("");
  const [editing,setEditing]=useState<Note|null>(null),[editBody,setEditBody]=useState(""),[editSpaces,setEditSpaces]=useState<string[]>([]);
  const [spaceDialog,setSpaceDialog]=useState(false),[spaceName,setSpaceName]=useState("");
  const [settings,setSettings]=useState(false),[switcher,setSwitcher]=useState(false),[offline,setOffline]=useState(false),[offlineReady,setOfflineReady]=useState(false);
  const refresh=useCallback(async()=>{const current=repo.current;if(!current)return;const data=await current.snapshot();if(repo.current!==current)return;setNotes(data.notes);setSpaces(data.spaces);setSketches(data.sketches);setRelations(data.relations);},[]);
  const fail=(e:unknown)=>setError(e instanceof Error?e.message:"保存できませんでした。入力内容を残して、もう一度お試しください。");
  const cloud=useRecallCloud({
    reset:()=>{repo.current=null;setReady(false);setNotes([]);setSpaces([]);setSketches([]);setRelations([]);openedItem.current=null;setBody("");setDraftSpaces([]);setDraftStatus("");setEditing(null);setEditBody("");setEditSpaces([]);setSpaceDialog(false);setSpaceName("");setSettings(false);setSwitcher(false);setQuery("");setView("all");setError("");setNotice("");setSaving(false);if(fileInput.current)fileInput.current.value="";},
    ready:(repository,data,draft)=>{repo.current=repository;setNotes(data.notes);setSpaces(data.spaces);setSketches(data.sketches);setRelations(data.relations);setBody(draft.body);setDraftSpaces(draft.spaceIds);setReady(true);if(draft.body)setDraftStatus("下書きを復元しました");},
    snapshot:data=>{setNotes(data.notes);setSpaces(data.spaces);setSketches(data.sketches);setRelations(data.relations);},failure:fail,
  });
  const requestSharing=useAtlasRequestSharing(ready?repo.current:null);
  const requestSpaceId=requestSharing.sharing?.spaceId;
  useEffect(()=>{
    if(!ready)return;
    const item=new URL(window.location.href).searchParams.get("item");
    if(!item||openedItem.current===item)return;
    const note=notes.find(note=>note.id===item);if(!note)return;
    openedItem.current=item;setQuery("");setView(note.deletedAt?"trash":"all");
    setEditing(note);setEditBody(note.body);setEditSpaces(note.spaceIds);
    const url=new URL(window.location.href);url.searchParams.delete("item");window.history.replaceState(null,"",url.pathname+url.search+url.hash);
  },[ready,notes]);
  useEffect(()=>{
    let active=true;
    const connection=()=>setOffline(!navigator.onLine);connection();
    window.addEventListener("online",connection);window.addEventListener("offline",connection);
    if(process.env.NODE_ENV==="production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/recall/sw.js",{scope:"/recall/"}).then(()=>navigator.serviceWorker.ready).then(()=>{if(active)setOfflineReady(true);}).catch(()=>{});
    }
    return()=>{active=false;window.removeEventListener("online",connection);window.removeEventListener("offline",connection);};
  },[]);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(""),6500);return()=>clearTimeout(timer);},[notice]);
  const [editRestored,setEditRestored]=useState(false);
  const lockDraft=useRef({body,draftSpaces,editing,editBody,editSpaces});lockDraft.current={body,draftSpaces,editing,editBody,editSpaces};
  useEffect(()=>{if(!ready){setEditRestored(false);return;}const current=repo.current;void current?.loadRecallEditDraft().then(d=>{if(repo.current!==current)return;if(d){const note=notes.find(n=>n.id===d.noteId);if(note){setEditing({...note,localRevision:d.revision});setEditBody(d.body);setEditSpaces(d.spaceIds);}}setEditRestored(true);}).catch(fail);},[ready]);
  useEffect(()=>{if(!ready||!editRestored)return;void repo.current?.saveRecallEditDraft(editing?{noteId:editing.id,body:editBody,spaceIds:editSpaces,revision:editing.localRevision}:null).catch(fail);},[ready,editRestored,editing,editBody,editSpaces]);
  useEffect(()=>beforeVaultLock(async()=>{const r=repo.current;if(!r)return;const d=lockDraft.current;await r.saveDraft(d.body,d.draftSpaces);await r.saveRecallEditDraft(d.editing?{noteId:d.editing.id,body:d.editBody,spaceIds:d.editSpaces,revision:d.editing.localRevision}:null);}),[]);
  const modalOpen=!!editing||spaceDialog||settings;
  useEffect(()=>{
    if(!modalOpen)return;
    const previous=document.activeElement as HTMLElement|null;
    const field=(!settings?modalRef.current?.querySelector<HTMLElement>("textarea,input"):null)??modalRef.current?.querySelector<HTMLElement>("button");
    field?.focus();
    return()=>previous?.focus();
  },[modalOpen]);
  useEffect(()=>{
    const escape=(e:KeyboardEvent)=>{if(e.key==="Escape"&&!saving){setEditing(null);setSpaceDialog(false);setSettings(false);setSwitcher(false);}};
    window.addEventListener("keydown",escape);return()=>window.removeEventListener("keydown",escape);
  },[saving]);
  function announce(){void cloud.runSync(false);}
  function persistDraft(nextBody:string,nextSpaces:string[]) {
    setBody(nextBody);setDraftSpaces(nextSpaces);setDraftStatus("下書きを保存中…");
    const current=repo.current;
    void current?.saveDraft(nextBody,nextSpaces).then(()=>{if(repo.current===current)setDraftStatus(nextBody?"下書きを端末に保存済み":"");}).catch(e=>{if(repo.current===current){setDraftStatus("下書きを保存できません");fail(e);}});
  }
  async function save() {
    const current=repo.current;if(!current||!body.trim()||saving)return;setSaving(true);setError("");
    try {await current.saveNote({body,spaceIds:draftSpaces});if(repo.current!==current)return;setBody("");setDraftSpaces([]);setDraftStatus("");await refresh();if(repo.current!==current)return;announce();setNotice("メモを端末に保存しました");}
    catch(e){if(repo.current===current)fail(e);}finally{if(repo.current===current){setSaving(false);composer.current?.focus();}}
  }
  async function update(note:Note,changes:Partial<Pick<Note,"body"|"spaceIds"|"pinned"|"deletedAt">>) {
    const current=repo.current;if(!current||saving)return;setSaving(true);setError("");
    try {await current.saveNote({...note,...changes},note.localRevision);if(repo.current!==current)return false;await refresh();if(repo.current!==current)return false;announce();return true;}
    catch(e){if(repo.current===current)fail(e);return false;}finally{if(repo.current===current)setSaving(false);}
  }
  async function addSpace(e:React.FormEvent) {
    e.preventDefault();const current=repo.current;if(!current||saving)return;setSaving(true);setError("");
    try {await current.createSpace(spaceName);if(repo.current!==current)return;await refresh();if(repo.current!==current)return;announce();setSpaceDialog(false);setSpaceName("");setNotice("スペースを追加しました");}catch(e){if(repo.current===current)fail(e);}finally{if(repo.current===current)setSaving(false);}
  }
  async function exportData() {
    const current=repo.current;
    try {if(!current)return;const backup=await current.exportBackup();if(repo.current!==current)return;const url=URL.createObjectURL(new Blob([await encryptBackup(backup)],{type:"application/json"}));const link=document.createElement("a");link.href=url;link.download=`recall-${new Date().toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setNotice("バックアップを書き出しました");}catch(e){if(repo.current===current)fail(e);}
  }
  async function importData(file:File|undefined) {
    const current=repo.current;if(!file||!current)return;if(file.size>100*1024*1024){setError("100MB以下のバックアップを選んでください。");return;}
    setSaving(true);setError("");
    try {const contents=await file.text();if(repo.current!==current)return;const count=await current.importBackup(await decryptBackup(JSON.parse(contents)));if(repo.current!==current)return;await refresh();if(repo.current!==current)return;announce();setNotice(`${count.notes}件のメモを追加しました（既存のメモは保持されます）`);}catch(e){if(repo.current===current)fail(e);}finally{if(repo.current===current){setSaving(false);if(fileInput.current)fileInput.current.value="";}}
  }
  const live=notes.filter(n=>!n.deletedAt), trash=notes.filter(n=>n.deletedAt);
  const selectedSpace=spaces.find(s=>s.id===view);
  const filtered=(view==="trash"?trash:live).filter(n=>(view!=="pinned"||n.pinned)&&(!selectedSpace||n.spaceIds.includes(view))&&matchesQuery(n,query)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const grouped=new Map<string,Note[]>();
  for(const note of filtered){const key=new Date(note.createdAt).toDateString();grouped.set(key,[...(grouped.get(key)??[]),note]);}
  const title=view==="pinned"?"大切にしたメモ":view==="trash"?"ごみ箱":selectedSpace?.name??"すべてのメモ";
  const syncLabel=cloud.identity.mode==="device"?(offline?"オフライン・端末内":"端末内モード"):cloud.syncStatus.phase==="syncing"?"同期中…":cloud.conflicts.length?`${cloud.conflicts.length}件の確認が必要`:cloud.syncStatus.phase==="error"?"同期できません":cloud.syncStatus.pending?`${cloud.syncStatus.pending}件の同期待ち`:cloud.syncStatus.lastSyncedAt?"クラウド同期済み":"アカウントのノート";
  return <div className="app-shell" data-identity={cloud.identity.mode}>
    <aside className="sidebar" aria-label="ナビゲーション" inert={modalOpen}>
      <a className="brand" href="/recall/" aria-label="Recall ホーム"><RecallMark/><span>Recall</span></a>
      <nav className="main-nav">
        <button className={view==="all"?"nav-item active":"nav-item"} onClick={()=>setView("all")}><Icon name="clock"/><span>すべてのメモ</span><span className="count">{live.length}</span></button>
        <button className={view==="pinned"?"nav-item active":"nav-item"} onClick={()=>setView("pinned")}><Icon name="star"/><span>ブックマーク</span><span className="count">{live.filter(n=>n.pinned).length}</span></button>
      </nav>
      <div className="section-label"><span>スペース</span><button className="icon-button" aria-label="スペースを追加" disabled={!ready} onClick={()=>setSpaceDialog(true)}><Icon name="plus" size={16}/></button></div>
      <nav className="spaces-nav" aria-label="スペース">{spaces.map(space=><button key={space.id} className={view===space.id?"nav-item active":"nav-item"} onClick={()=>setView(space.id)}><span className="space-dot" style={{background:space.color}}/><span>{space.name}</span><span className="count">{live.filter(n=>n.spaceIds.includes(space.id)).length}</span></button>)}</nav>
      <div className="sidebar-bottom"><button className={view==="trash"?"nav-item active":"nav-item"} onClick={()=>setView("trash")}><Icon name="trash"/><span>ごみ箱</span><span className="count">{trash.length}</span></button>
        <button className="device-card" onClick={()=>setSettings(true)}><span className="device-avatar">私</span><span><strong>{cloud.identity.mode==="account"?"アカウントのノート":"自分のノート"}</strong><small>{cloud.identity.mode==="account"?"クラウドと同期":"この端末に保存"}</small></span><Icon name="more"/></button>
      </div>
    </aside>
    <div className="main-pane" inert={modalOpen}>
      <header className="topbar"><span className="breadcrumb">自分のノート <span>/</span> Recall</span><span className="mobile-brand"><RecallMark/>Recall</span>
        <div className="top-actions"><button className={`local-status sync-status-button ${cloud.syncStatus.phase==="error"?"has-error":""}`} onClick={()=>setSettings(true)} aria-label={`保存状態: ${syncLabel}`}><span className="status-dot"/>{syncLabel}</button><div className="switcher-wrap"><button className="icon-button" aria-label="ツール一覧" aria-expanded={switcher} onClick={()=>setSwitcher(!switcher)}><Icon name="grid"/></button>{switcher&&<div className="switcher"><strong>あなたのツール</strong>{[["Recall","思考を残す","使用中"],["Sketchbook","描いて残す","開く"],["Collect","資料を集める","開く"],["Atlas","つながりを見つける","開く"]].map(([name,description,state])=>(name==="Sketchbook"||name==="Collect"||name==="Atlas")?<a key={name} href={name==="Atlas"?"/atlas/":name==="Collect"?"/collect/":"/sketchbook/"}><span>{name}<small>{description}</small></span><em>{state}</em></a>:<div key={name}><span>{name}<small>{description}</small></span><em>{state}</em></div>)}</div>}</div><button className="icon-button" aria-label="保存とバックアップ" onClick={()=>setSettings(true)}><Icon name="more"/></button></div>
      </header>
      <main className="content">
        <div className="intro"><div><p className="eyebrow">MEMO</p><h1>メモを書く</h1>
        </div><span className="intro-mark" aria-hidden="true">✳</span></div>
        <section className="composer" aria-label="新しいメモ">
          <label className="sr-only" htmlFor="new-note">メモの本文</label>
          <textarea id="new-note" ref={composer} value={body} onChange={e=>persistDraft(e.target.value,draftSpaces)} onKeyDown={e=>{if((e.metaKey||e.ctrlKey)&&e.key==="Enter"&&!e.nativeEvent.isComposing){e.preventDefault();void save();}}} disabled={!ready||saving} maxLength={100000} placeholder={ready?"メモの本文":"ノートを開いています…"} rows={3}/>
          <div className="composer-footer"><div className="space-chips" aria-label="メモのスペース">{spaces.map(space=><button key={space.id} className={`chip ${draftSpaces.includes(space.id)?"selected":""}`} aria-pressed={draftSpaces.includes(space.id)} disabled={!ready||saving} onClick={()=>persistDraft(body,draftSpaces.includes(space.id)?draftSpaces.filter(id=>id!==space.id):[...draftSpaces,space.id])}><span className="space-dot" style={{background:space.color}}/>{space.name}</button>)}</div><div className="save-action"><span className="keyboard-hint">Ctrl / ⌘ + Enter</span><Button className="primary" onClick={()=>void save()} disabled={!ready||!body.trim()||saving}>{saving?"保存中…":"メモを残す"}<Icon name="arrow" size={16}/></Button></div></div>
        </section>
        {requestSpaceId&&(view===requestSpaceId||draftSpaces.includes(requestSpaceId))&&<div className="sharing-warning" role="note"><p>Codex向けの共有元です。「Atlas要望」を選んで保存したメモは、本文全体が書き出し対象になります。</p><button className="text-button" onClick={()=>setSettings(true)}>Codex向けの書き出しを開く</button></div>}
        <div className="mobile-nav"><select aria-label="メモの表示範囲" value={view} onChange={e=>setView(e.target.value)}><option value="all">すべてのメモ</option><option value="pinned">大切にしたメモ</option>{spaces.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}<option value="trash">ごみ箱</option></select><button className="icon-button" aria-label="スペースを追加" onClick={()=>setSpaceDialog(true)}><Icon name="plus"/></button></div>
        <div className="list-toolbar"><h2>{title}<span>{filtered.length}</span></h2><label className="search"><Icon name="search" size={17}/><input aria-label="メモを検索" placeholder="本文を検索" value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button className="icon-button" aria-label="検索をクリア" onClick={()=>setQuery("")}><Icon name="close" size={14}/></button>}</label></div>
        {error&&<div className="error" role="alert"><span>{error}</span><button className="icon-button" aria-label="エラーを閉じる" onClick={()=>setError("")}><Icon name="close" size={16}/></button></div>}
        {cloud.authMessage&&<p className="auth-message" role="status">{cloud.authMessage}</p>}
        {view==="trash"&&<p className="muted">ごみ箱のメモはここから戻せます。この初版では自動削除しません。</p>}
        {filtered.length===0?<div className="empty"><span className="empty-symbol" aria-hidden="true">⌁</span><h3>{query?"一致するメモがありません":view==="trash"?"ごみ箱は空です。":view==="pinned"?"ブックマークがありません":"メモがありません"}</h3><p>{query?"別の言葉や、短い言葉で探してみてください。":view==="trash"?"ごみ箱に移したメモをここに表示します。":view==="pinned"?"メモの星を押すと、ここに表示します。":"上の入力欄からメモを保存できます。"}</p>{!query&&view==="all"&&<button className="text-button" onClick={()=>composer.current?.focus()}>メモを書く <Icon name="arrow" size={15}/></button>}</div>:
          <div className="timeline">{Array.from(grouped.entries()).map(([key,group])=><section className="day-group" key={key}><div className="day-heading"><h3>{dayLabel(group[0].createdAt)}</h3><span>{new Intl.DateTimeFormat("ja-JP",{year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(group[0].createdAt))}</span><div/></div><div className="note-grid">{group.map(note=><article key={note.id} className={`note-card ${note.pinned?"is-pinned":""}`}><div className="note-top"><time dateTime={note.createdAt}>{timeLabel(note.createdAt)}</time><div className="note-actions">{!note.deletedAt&&<><button className={`icon-button star-button ${note.pinned?"starred":""}`} aria-label={note.pinned?"大切にしたメモから外す":"大切にしたメモに追加"} aria-pressed={note.pinned} disabled={saving} onClick={()=>void update(note,{pinned:!note.pinned})}><Icon name="star" size={16}/></button><button className="icon-button" aria-label={`編集: ${noteTitle(note.body)}`} onClick={()=>{setEditing(note);setEditBody(note.body);setEditSpaces(note.spaceIds);}}><Icon name="edit" size={16}/></button><button className="icon-button" aria-label={`ごみ箱へ: ${noteTitle(note.body)}`} disabled={saving} onClick={async()=>{if(await update(note,{deletedAt:new Date().toISOString()}))setNotice("ごみ箱に移しました。「ごみ箱」から戻せます");}}><Icon name="trash" size={16}/></button></>}{note.deletedAt&&<button className="restore-button" disabled={saving} onClick={async()=>{if(await update(note,{deletedAt:null}))setNotice("メモを元に戻しました");}}><Icon name="restore" size={16}/>戻す</button>}</div></div><p className="note-body">{note.body}</p>{!note.deletedAt&&<div className="note-connections">{relations.filter(relation=>!relation.deletedAt&&relation.type==="inspired_by"&&relation.toItemId===note.id).map(relation=>sketches.find(sketch=>sketch.id===relation.fromItemId&&!sketch.deletedAt)).filter((sketch):sketch is Sketch=>!!sketch).map(sketch=><a key={sketch.id} href={`/sketchbook/?item=${encodeURIComponent(sketch.id)}`}>↗ {sketch.title||"無題のスケッチ"}</a>)}</div>}<div className="note-footer"><div className="note-spaces">{note.spaceIds.map(id=>spaces.find(s=>s.id===id)).filter((s):s is Space=>!!s).map(space=><span key={space.id}><i style={{background:space.color}}/>{space.name}</span>)}</div><span className="saved-label"><Icon name="check" size={12}/>{cloud.identity.mode==="device"?"端末に保存":cloud.conflicts.some(c=>c.entityId===note.id)?"確認が必要":cloud.pendingItemIds.includes(note.id)||note.serverRevision===null?"同期待ち":"クラウドに保存"}</span></div></article>)}</div></section>)}</div>}
        <footer className="page-footer"><button onClick={()=>setSettings(true)}>保存とバックアップ</button></footer>
      </main>
    </div>
    {notice&&<div className="toast" role="status"><Icon name="check" size={17}/>{notice}</div>}
    {modalOpen&&<div className="modal-backdrop" onClick={e=>{if(e.target===e.currentTarget&&!saving){setEditing(null);setSpaceDialog(false);setSettings(false);}}}><section ref={modalRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onKeyDown={e=>{
      if(e.key!=="Tab")return;const nodes=e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)');const first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
    }}><div className="modal-heading"><h2 id="dialog-title">{editing?"メモをひらく":spaceDialog?"新しいスペース":"保存とバックアップ"}</h2><button className="icon-button" aria-label="閉じる" disabled={saving} onClick={()=>{setEditing(null);setSpaceDialog(false);setSettings(false);}}><Icon name="close"/></button></div>
      {editing&&<form onSubmit={async e=>{e.preventDefault();if(await update(editing,{body:editBody,spaceIds:editSpaces})){setEditing(null);setNotice("メモを更新しました");}}}>{requestSpaceId&&editSpaces.includes(requestSpaceId)&&<p className="sharing-warning">このメモはCodex向けの書き出し対象です。ほかのスペースにも置いていても、保存済みの本文全体が対象になります。</p>}<textarea aria-label="メモを編集" autoFocus className="edit-textarea" rows={9} value={editBody} maxLength={100000} disabled={saving} onChange={e=>setEditBody(e.target.value)}/><div className="space-chips">{spaces.map(s=><button key={s.id} type="button" className={`chip ${editSpaces.includes(s.id)?"selected":""}`} aria-pressed={editSpaces.includes(s.id)} disabled={saving} onClick={()=>setEditSpaces(editSpaces.includes(s.id)?editSpaces.filter(id=>id!==s.id):[...editSpaces,s.id])}><span className="space-dot" style={{background:s.color}}/>{s.name}</button>)}</div><div className="modal-actions"><Button type="button" onClick={()=>setEditing(null)} disabled={saving}>閉じる</Button><Button type="submit" className="primary" disabled={!editBody.trim()||saving}>変更を保存</Button></div></form>}
      {spaceDialog&&<form onSubmit={addSpace}><p className="muted">1つのメモを複数のスペースに置けます。</p><label className="field-label" htmlFor="space-name">スペース名</label><input id="space-name" className="text-input" autoFocus value={spaceName} maxLength={40} onChange={e=>setSpaceName(e.target.value)} placeholder="例：旅のこと" disabled={saving}/><div className="modal-actions"><Button className="primary" disabled={!spaceName.trim()||saving}>スペースを作る</Button></div></form>}
      {settings&&<><p className="storage-note"><span className="status-dot"/>{cloud.identity.mode==="account"?"アカウントのメモを、まずこの端末に保存します。":"このブラウザの、この端末に保存しています。"}</p><AtlasRequestsSettings repository={ready?repo.current:null} spaces={spaces} notes={notes} state={requestSharing} onPrepared={spaceId=>{setView(spaceId);setSettings(false);void refresh().catch(fail);announce();}} onNotice={setNotice}/><hr/><CloudSettings cloud={cloud} onNotice={setNotice} onError={fail}/><hr/><h3>バックアップ</h3><p className="muted">ブラウザのデータを消す前や、端末を変える前にバックアップを書き出してください。クラウド同期が未完了の変更も、保存済みのメモなら書き出せます。</p><div className="backup-actions"><Button onClick={()=>void exportData()} disabled={!ready||saving}><Icon name="download"/>バックアップを書き出す</Button><Button onClick={()=>fileInput.current?.click()} disabled={!ready||saving}><Icon name="upload"/>バックアップを読み込む</Button></div><p className="small-note">読み込みは追加方式です。同じファイルを再び読むとメモも再び追加されます。書き出しには保存済みメモ・ごみ箱・スペースが含まれ、入力中の下書きは含みません。</p><hr/><h3>ホーム画面に追加</h3><p className="muted">スマートフォンではブラウザのメニューから「ホーム画面に追加」。iPhoneではSafariの共有メニューから追加できます。</p><p className="small-note">{offlineReady?"オフライン用の画面を準備できました。":"オフラインでの再起動は、本番用サーバーで一度開き、画面の準備が完了すると利用できます。"} {offline?"現在はオフラインです。":""}</p><Button onClick={async()=>{try{const kept=await navigator.storage?.persist();setNotice(kept?"端末内データの保持が許可されました（バックアップも続けてください）":"保持をリクエストしました。バックアップも続けてください");}catch(e){fail(e);}}}>端末内データの保持をリクエスト</Button></>}
      {error&&<p className="error" role="alert">{error}</p>}
    </section></div>}
    <input type="file" hidden accept="application/json,.json" ref={fileInput} onChange={e=>void importData(e.target.files?.[0])}/>
  </div>;
}
