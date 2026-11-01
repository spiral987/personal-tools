"use client";
import {GoogleSignInButton} from "@personal-tools/auth/google";
import {VaultRetentionSettings} from "@personal-tools/auth/vault";
import {Modal,SuiteShell,SearchField,SectionHeading,RecordGrid,SaveState,useDraftNavigation,useSuiteOrganization} from "@personal-tools/ui";
import {encryptBackup,decryptBackup,beforeVaultLock,flushVaultDrafts} from "@personal-tools/api-client";
import {useEffect,useRef,useState,type ReactNode,type MouseEvent} from "react";
import type {ItemRelation,Note,Sketch,SketchDraft,SketchStroke,SyncRecord} from "@personal-tools/core";
import type {RecallRepository} from "@personal-tools/api-client";
import {ConflictError,uploadEncryptedSketchPreview as uploadSketchPreview} from "@personal-tools/api-client";
import {usePersonalToolsCloud,type CloudSnapshot} from "@personal-tools/auth/react";
import {getBrowserAuthClient} from "@personal-tools/auth/browser";
import {DrawingCanvas,SketchThumbnail} from "./drawing-canvas";
import {commitStroke,undoStroke,redoStroke,drawingPng} from "./drawing";
import {sketchDraftFingerprint as fingerprint,shouldRestoreSketchDraft} from "./draft-recovery";

const EMPTY:CloudSnapshot={notes:[],spaces:[],sketches:[],relations:[],resources:[],projects:[],labels:[]};
const blank=():SketchDraft=>({title:"",strokes:[],spaceIds:[]});
const draftOf=(sketch:Sketch):SketchDraft=>({title:sketch.title,strokes:sketch.strokes,spaceIds:sketch.spaceIds,editingId:sketch.id,expectedRevision:sketch.localRevision});
const date=(value:string)=>new Intl.DateTimeFormat("ja-JP",{month:"short",day:"numeric"}).format(new Date(value));
const titleOf=(note:Note)=>note.body.trim().split("\n")[0].slice(0,65);
type SymbolName="pen"|"eraser"|"undo"|"redo"|"plus"|"trash"|"save"|"download"|"settings"|"arrow"|"close"|"grid"|"link"|"check";
function Icon({name,size=18}:{name:SymbolName;size?:number}){
  const paths:Record<SymbolName,ReactNode>={
    pen:<><path d="m4 15-1 6 6-1L21 8l-5-5Z"/><path d="m13 6 5 5M4 15l5 5"/></>,eraser:<><path d="m4 13 9-10 8 8-9 10H8l-6-6Z"/><path d="m7 10 8 8M12 21h10"/></>,undo:<><path d="m8 4-5 5 5 5"/><path d="M3 9h10a7 7 0 0 1 0 14"/></>,redo:<><path d="m16 4 5 5-5 5"/><path d="M21 9H11a7 7 0 0 0 0 14"/></>,plus:<path d="M12 4v16M4 12h16"/>,trash:<><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/></>,save:<><path d="M4 3h13l4 4v14H3V3Z"/><path d="M7 3v6h9V3M7 21v-8h10v8"/></>,download:<><path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/></>,settings:<><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3Z"/></>,arrow:<><path d="M5 12h14m-5-5 5 5-5 5"/></>,close:<path d="m6 6 12 12M6 18 18 6"/>,grid:<><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,link:<><path d="m9 15 6-6M6 13l-2 2a4 4 0 0 0 5 6l4-4M11 7l4-4a4 4 0 0 1 6 5l-2 2"/></>,check:<path d="m5 12 4 4L20 5"/>,
  };return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
function Version({record}:{record:SyncRecord}){
  if("kind" in record&&record.kind==="sketch")return <div className="version"><SketchThumbnail strokes={record.strokes}/><p>{record.title||"無題のスケッチ"}{record.deletedAt?"（ごみ箱）":""}</p></div>;
  if("kind" in record&&record.kind==="resource")return <p className="version-text">{record.title||record.url||"収集した画像"}<br/>{record.memo}</p>;
  if("body" in record)return <p className="version-text">{record.body}</p>;
  if("name" in record)return <p>{record.name}</p>;
  return <p className="muted">メモとの関連付け{record.deletedAt?"（解除済み）":""}</p>;
}
function download(blob:Blob,name:string){const url=URL.createObjectURL(blob),anchor=document.createElement("a");anchor.href=url;anchor.download=name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

export default function Sketchbook(){
  const repository=useRef<RecallRepository|null>(null),epoch=useRef(0),version=useRef(0),draftQueue=useRef(Promise.resolve()),leaving=useRef(false);
  const [data,setData]=useState<CloudSnapshot>(EMPTY),[ready,setReady]=useState(false),[editor,setEditor]=useState<SketchDraft>(blank);
  const editorRef=useRef(editor);editorRef.current=editor;
  const [baseline,setBaseline]=useState(()=>fingerprint(blank())),[redo,setRedo]=useState<SketchStroke[]>([]);
  const [tool,setTool]=useState<"pen"|"eraser">("pen"),[color,setColor]=useState("#353b37"),[width,setWidth]=useState(5);
  const [drawing,setDrawing]=useState(false),[saving,setSaving]=useState(false),[draftSaved,setDraftSaved]=useState(true),[error,setError]=useState(""),[notice,setNotice]=useState(""),[saveConflict,setSaveConflict]=useState(false);
  const draftSavedRef=useRef(draftSaved);draftSavedRef.current=draftSaved;
  const [view,setView]=useState<"all"|"trash">("all"),[search,setSearch]=useState(""),[spaceFilter,setSpaceFilter]=useState("");
  const [modal,setModal]=useState<"settings"|"sources"|null>(null),[pendingNavigation,setPendingNavigation]=useState<(()=>void)|null>(null);
  const [pendingSource,setPendingSource]=useState(""),[email,setEmail]=useState(""),[sourceSearch,setSourceSearch]=useState("");
  const sourceRef=useRef(pendingSource);sourceRef.current=pendingSource;
  const [busy,setBusy]=useState(false),[spaceName,setSpaceName]=useState(""),[offline,setOffline]=useState(false),[pwaState,setPwaState]=useState("");
  const [previewStates,setPreviewStates]=useState<Record<string,"pending"|"uploaded"|"error">>({}),[previewRetry,setPreviewRetry]=useState(0);
  const previews=useRef(new Set<string>()),importInput=useRef<HTMLInputElement>(null);
  const dirty=fingerprint(editor)!==baseline||!!pendingSource;
  function context(){const repo=repository.current,at=epoch.current;return {repo,current:()=>repo===repository.current&&at===epoch.current};}
  function failure(value:unknown){setError(value instanceof Error?value.message:"保存できませんでした。入力は残しています。");}
  function installEditor(draft:SketchDraft,saved?:Sketch){
    version.current++;editorRef.current=structuredClone(draft);setEditor(editorRef.current);setRedo([]);
    setBaseline(fingerprint(saved?draftOf(saved):blank()));setDraftSaved(false);setError("");setSaveConflict(false);
  }
  const cloud=usePersonalToolsCloud({
    reset(){epoch.current++;version.current++;repository.current=null;editorRef.current=blank();setEditor(editorRef.current);setBaseline(fingerprint(blank()));setData(EMPTY);setReady(false);setRedo([]);setPendingSource("");setPendingNavigation(null);setSaving(false);setBusy(false);setDrawing(false);setError("");setNotice("");setEmail("");setSourceSearch("");setSpaceName("");setSearch("");setSpaceFilter("");setView("all");setSaveConflict(false);previews.current.clear();setPreviewStates({});},
    ready(repo,snapshot,draft){
      repository.current=repo;setData(snapshot);setReady(true);
      const url=new URL(window.location.href),from=url.searchParams.get("from"),item=url.searchParams.get("item");
      setPendingSource(draft.sourceNoteId||(from&&snapshot.notes.some(note=>note.id===from&&!note.deletedAt)?from:""));
      const saved=draft.editingId?snapshot.sketches.find(sketch=>sketch.id===draft.editingId):undefined;
      const recovered=shouldRestoreSketchDraft(draft,saved);
      const requested=item?snapshot.sketches.find(sketch=>sketch.id===item):undefined;
      if(recovered){installEditor(draft,saved);setNotice("描きかけの下書きを復元しました");}
      else if(requested)installEditor(draftOf(requested),requested);
      else if(from)installEditor(blank());
      else installEditor(draft,saved);
      if(item&&!requested)setNotice("指定したスケッチは、同期後に一覧から開けます");
      setDraftSaved(fingerprint(editorRef.current)===fingerprint(draft)&&!(from&&!draft.sourceNoteId));
    },
    snapshot(snapshot){setData(snapshot);},failure,
  },{app:"sketchbook"});
  const organization=useSuiteOrganization({repository:ready?repository.current:null,projects:data.projects,spaces:data.spaces,beforeChange:flushVaultDrafts,changed:()=>{void cloud.refresh();void cloud.runSync(false);},failure});
  const previewInputs=useRef({data,pending:cloud.pendingItemIds,conflicts:cloud.conflicts,identity:cloud.identity});previewInputs.current={data,pending:cloud.pendingItemIds,conflicts:cloud.conflicts,identity:cloud.identity};
  useEffect(()=>()=>{epoch.current++;},[]);

  const selected=data.sketches.find(sketch=>sketch.id===editor.editingId),deleted=!!selected?.deletedAt;
  const stale=!!selected&&editor.expectedRevision!==selected.localRevision;
  const activeRelations=data.relations.filter(relation=>!relation.deletedAt&&relation.type==="inspired_by"&&relation.fromItemId===editor.editingId&&data.notes.some(note=>note.id===relation.toItemId));
  const sourceNotes=activeRelations.map(relation=>({relation,note:data.notes.find(note=>note.id===relation.toItemId)}));
  const liveNotes=data.notes.filter(note=>!note.deletedAt);
  const shown=data.sketches.filter(sketch=>(view==="trash"?!!sketch.deletedAt:!sketch.deletedAt)&&organization.matches(sketch.id)&&(!spaceFilter||sketch.spaceIds.includes(spaceFilter))&&sketch.title.normalize("NFKC").toLocaleLowerCase("ja").includes(search.normalize("NFKC").toLocaleLowerCase("ja"))).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  const currentPreviewKeys=new Set(data.sketches.filter(sketch=>!sketch.deletedAt&&sketch.serverRevision&&!cloud.pendingItemIds.includes(sketch.id)).map(sketch=>`${sketch.id}:${sketch.serverRevision}`));
  const pendingPreviews=Object.entries(previewStates).filter(([key,state])=>currentPreviewKeys.has(key)&&state==="pending").length,failedPreviews=Object.entries(previewStates).filter(([key,state])=>currentPreviewKeys.has(key)&&state==="error").length;
  const status=!ready?"読み込み中…":cloud.identity.mode==="device"?"端末内モード":cloud.syncStatus.phase==="syncing"?"原本を同期中…":cloud.syncStatus.phase==="error"?"同期を確認してください":cloud.conflicts.length?"競合の確認が必要":cloud.syncStatus.pending?`同期待ち ${cloud.syncStatus.pending}件`:pendingPreviews?"原本同期済み · 画像準備中":failedPreviews?"原本同期済み · 画像の再送が必要":"クラウド同期済み";

  function mutate(change:Partial<SketchDraft>){version.current++;setDraftSaved(false);setEditor(current=>{const next={...current,...change};editorRef.current=next;return next;});}
  function changeHistory(kind:"undo"|"redo",history={strokes:editorRef.current.strokes,redo}){const next=kind==="undo"?undoStroke(history):redoStroke(history);if(next===history)return;setRedo(next.redo);mutate({strokes:next.strokes});}
  function append(stroke:SketchStroke){const current=editorRef.current.strokes;if(current.length>=2000||current.reduce((count,item)=>count+item.points.length,0)+stroke.points.length>20000){setError("この紙の描画上限に達しました。保存して、新しいスケッチを作ってください。");return;}const next=commitStroke({strokes:current,redo},stroke);setRedo(next.redo);mutate({strokes:next.strokes});}
  useEffect(()=>beforeVaultLock(()=>draftSavedRef.current?draftQueue.current:queueDraft(structuredClone(editorRef.current))),[]);
  function queueDraft(draft:SketchDraft,sourceNoteId=sourceRef.current){const repo=repository.current,at=epoch.current;if(!repo)return Promise.resolve();const captured={...draft,sourceNoteId:sourceNoteId||undefined};draftQueue.current=draftQueue.current.catch(()=>{}).then(async()=>{if(at!==epoch.current||repo!==repository.current)return;await repo.saveSketchDraft(captured);if(at===epoch.current&&fingerprint(editorRef.current)===fingerprint(draft)&&sourceRef.current===sourceNoteId)setDraftSaved(true);});return draftQueue.current;}
  useEffect(()=>{if(selected&&stale&&!dirty&&!saving&&!drawing)installEditor(draftOf(selected),selected);},[selected,stale,dirty,saving,drawing]);
  useEffect(()=>{if(!ready||draftSavedRef.current)return;const guard=context();const timer=setTimeout(()=>{void queueDraft(structuredClone(editor)).catch(value=>{if(guard.current())failure(value);});},250);return()=>clearTimeout(timer);},[editor,pendingSource,ready]);

  useEffect(()=>{const update=()=>setOffline(!navigator.onLine);update();window.addEventListener("online",update);window.addEventListener("offline",update);return()=>{window.removeEventListener("online",update);window.removeEventListener("offline",update);};},[]);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(""),5000);return()=>clearTimeout(timer);},[notice]);
  useEffect(()=>{
    if(process.env.NODE_ENV!=="production"||!("serviceWorker" in navigator)){setPwaState("オフライン起動は本番モードで準備します");return;}
    let alive=true;navigator.serviceWorker.register("/sketchbook/sw.js",{scope:"/sketchbook/"}).then(async registration=>{await navigator.serviceWorker.ready;if(alive)setPwaState(registration.active?"オフライン起動の準備完了":"次回の起動でオフラインに対応します");}).catch(()=>{if(alive)setPwaState("オフライン用画面の準備を確認できませんでした");});
    return()=>{alive=false;};
  },[]);
  useEffect(()=>{
    function keyboard(event:KeyboardEvent){const target=event.target as HTMLElement;if(target.closest("input,textarea,select,[contenteditable=true]")||modal||pendingNavigation)return;
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="z"){event.preventDefault();if(!deleted&&!drawing)changeHistory(event.shiftKey?"redo":"undo");}
      else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="s"){event.preventDefault();if(!saving&&!deleted&&!drawing)void save();}
    }
    window.addEventListener("keydown",keyboard);return()=>window.removeEventListener("keydown",keyboard);
  });
  useEffect(()=>{
    if(cloud.identity.mode!=="account"||!ready)return;const auth=getBrowserAuthClient();if(!auth)return;
    const ownerId=cloud.identity.userId,at=epoch.current;
    const candidates=data.sketches.filter(sketch=>!sketch.deletedAt&&sketch.serverRevision&&!cloud.pendingItemIds.includes(sketch.id)&&!cloud.conflicts.some(conflict=>conflict.entityId===sketch.id));
    function stillCanonical(sketch:Sketch){const latest=previewInputs.current,current=latest.data.sketches.find(record=>record.id===sketch.id);return at===epoch.current&&latest.identity.mode==="account"&&latest.identity.userId===ownerId&&current?.serverRevision===sketch.serverRevision&&!current.deletedAt&&!latest.pending.includes(sketch.id)&&!latest.conflicts.some(conflict=>conflict.entityId===sketch.id);}
    void(async()=>{for(const sketch of candidates){const key=`${sketch.id}:${sketch.serverRevision}`;if(at!==epoch.current)break;if(previews.current.has(key)||!stillCanonical(sketch))continue;previews.current.add(key);setPreviewStates(current=>({...current,[key]:"pending"}));try{const blob=await drawingPng(sketch.strokes);if(!stillCanonical(sketch)){previews.current.delete(key);if(at===epoch.current)setPreviewStates(current=>{const next={...current};delete next[key];return next;});continue;}await uploadSketchPreview(auth,ownerId,sketch,blob);if(at===epoch.current)setPreviewStates(current=>({...current,[key]:"uploaded"}));}catch{if(at===epoch.current)setPreviewStates(current=>({...current,[key]:"error"}));}}})();
  },[data.sketches,cloud.identity,cloud.pendingItemIds,cloud.conflicts,ready,previewRetry]);

  async function save(asCopy=false):Promise<boolean>{
    const repo=repository.current;if(!repo||saving||drawing||deleted&&!asCopy)return false;
    const captured=structuredClone(editorRef.current),at=epoch.current,saveVersion=version.current;
    if(asCopy){delete captured.editingId;delete captured.expectedRevision;}
    setSaving(true);setError("");
    try{
      const saved=await repo.saveSketch({id:captured.editingId,title:captured.title,strokes:captured.strokes,spaceIds:captured.spaceIds},captured.expectedRevision);
      if(at!==epoch.current||repo!==repository.current)return false;
      const next=version.current===saveVersion?draftOf(saved):{...editorRef.current,editingId:saved.id,expectedRevision:saved.localRevision};
      editorRef.current=next;setEditor(next);setBaseline(fingerprint(draftOf(saved)));setSaveConflict(false);await queueDraft(structuredClone(next));
      if(at!==epoch.current||repo!==repository.current)return false;
      const url=new URL(window.location.href);url.searchParams.set("item",saved.id);window.history.replaceState(null,"",url.pathname+url.search);
      if(pendingSource){try{await repo.saveRelation({fromItemId:saved.id,toItemId:pendingSource,type:"inspired_by"});if(at!==epoch.current||repo!==repository.current)return false;setPendingSource("");url.searchParams.delete("from");window.history.replaceState(null,"",url.pathname+url.search);}catch(value){if(at!==epoch.current||repo!==repository.current)return false;failure(value);setNotice("スケッチは保存しました。メモとの関連付けを確認してください");return true;}}
      setNotice(version.current===saveVersion?"スケッチを保存しました":"保存しました。描き足した分は下書きに残っています");return true;
    }catch(value){if(at===epoch.current){failure(value);if(value instanceof ConflictError)setSaveConflict(true);}return false;}
    finally{if(at===epoch.current)setSaving(false);}
  }
  function navigate(work:()=>void){if(saving||drawing)return;if(dirty){setPendingNavigation(()=>work);return;}const guard=context();void queueDraft(editorRef.current).then(()=>{if(guard.current())work();}).catch(value=>{if(guard.current())failure(value);});}
  function open(sketch:Sketch){navigate(()=>{installEditor(draftOf(sketch),sketch);setPendingSource("");const url=new URL(window.location.href);url.searchParams.set("item",sketch.id);url.searchParams.delete("from");window.history.replaceState(null,"",url.pathname+url.search);});}
  function newSketch(){navigate(()=>{installEditor(blank());setPendingSource("");const url=new URL(window.location.href);url.search="";window.history.replaceState(null,"",url.pathname);setView("all");});}
  function appLink(event:MouseEvent<HTMLAnchorElement>,href:string){navigation.follow(event,href);}
  async function perform(work:(guard:ReturnType<typeof context>)=>Promise<void>){if(busy)return;const guard=context();setBusy(true);try{await work(guard);}catch(value){if(guard.current())failure(value);}finally{if(guard.current())setBusy(false);}}
  async function trash(sketch:Sketch){const guard=context();if(!guard.repo)return;const updated=await guard.repo.updateSketch(sketch.id,{deletedAt:sketch.deletedAt?null:new Date().toISOString()},sketch.localRevision);if(!guard.current())return;if(editorRef.current.editingId===sketch.id)installEditor(draftOf(updated),updated);setNotice(sketch.deletedAt?"スケッチを戻しました":"ごみ箱へ移しました");}
  async function addSource(note:Note){const guard=context();if(!guard.repo)return;if(!editor.editingId){setPendingSource(note.id);setModal(null);return;}await guard.repo.saveRelation({fromItemId:editor.editingId,toItemId:note.id,type:"inspired_by"});if(!guard.current())return;setNotice("着想元のメモを関連付けました");setModal(null);}
  async function removeSource(relation:ItemRelation){const guard=context();await guard.repo?.deleteRelation(relation.id,relation.localRevision);if(guard.current())setNotice("関連付けを解除しました");}
  function retryPreviews(){setPreviewStates(current=>{const next={...current};for(const [key,state]of Object.entries(current))if(state==="error"){previews.current.delete(key);delete next[key];}return next;});setPreviewRetry(value=>value+1);}

  const navigation=useDraftNavigation({blocked:!ready||saving||drawing||busy,hasDraft:dirty,failure,onLeaving:()=>{leaving.current=true;},prepare:async()=>{
    const guard=context();if(!guard.repo)return false;await queueDraft(structuredClone(editorRef.current));return guard.current();
  }});
  return <SuiteShell tool="sketchbook" title="スケッチを描く" status={status} warning={!!failedPreviews||cloud.syncStatus.phase==="error"} navigation={navigation} sidebarExtra={organization.sidebar} projectFilter={organization.filter}
    search={<SearchField label="スケッチを探す" value={search} onChange={setSearch} placeholder="タイトルで検索"/>}
    views={[{id:"all",label:"すべてのスケッチ",count:data.sketches.filter(sketch=>!sketch.deletedAt).length},{id:"trash",label:"ごみ箱",count:data.sketches.filter(sketch=>sketch.deletedAt).length}]} view={view} onViewChange={value=>{setView(value as "all"|"trash");setSpaceFilter("");}}
    spaces={data.spaces.map(space=>({...space,count:data.sketches.filter(sketch=>!sketch.deletedAt&&sketch.spaceIds.includes(space.id)).length}))} space={spaceFilter} onSpaceChange={setSpaceFilter} onAddSpace={()=>setModal("settings")} onSettings={()=>setModal("settings")}
    actions={<button className="button" onClick={newSketch} disabled={!ready||saving||drawing}><Icon name="plus" size={16}/>新しいスケッチ</button>}>
        {error&&<div className="error" role="alert"><span>{error}</span><button className="icon-button" onClick={()=>setError("")} aria-label="エラー表示を閉じる"><Icon name="close" size={15}/></button></div>}
        {(stale||saveConflict)&&dirty&&<div className="warning-note"><p>別の画面でこのスケッチが更新されました。描きかけの内容は下書きに残っています。</p><div className="modal-buttons"><button className="button primary" disabled={saving||drawing} onClick={()=>void save(true)}>別の一枚として保存</button><button className="button" disabled={saving} onClick={()=>selected&&open(selected)}>最新の保存内容を開く</button></div></div>}
        <section className="drawing-panel" aria-label="スケッチの編集">
          <div className="paper-heading"><input aria-label="スケッチのタイトル" maxLength={120} value={editor.title} disabled={!ready||deleted} onChange={event=>mutate({title:event.target.value})} placeholder="無題のスケッチ"/><SaveState className="paper-state">{deleted?"ごみ箱":!ready?"読み込み中":saving?"保存中…":dirty?draftSaved?"下書きを端末に保存済み":"下書きを保存中…":editor.editingId?"保存済み":"新しい一枚"}</SaveState></div>
          <div className="drawing-toolbar" aria-label="描画ツール">
            <div className="tool-group"><button className={`tool-button ${tool==="pen"?"active":""}`} aria-pressed={tool==="pen"} onClick={()=>setTool("pen")} title="ペン"><Icon name="pen"/><span>ペン</span></button><button className={`tool-button ${tool==="eraser"?"active":""}`} aria-pressed={tool==="eraser"} onClick={()=>setTool("eraser")} title="消しゴム"><Icon name="eraser"/><span>消しゴム</span></button></div>
            <span className="tool-divider"/>
            <div className="palette" aria-label="ペンの色">{["#353b37","#7c8f80","#8c7ca6","#bb816b","#d1ad67"].map(value=><button key={value} className={`color-swatch ${color===value?"selected":""}`} style={{"--swatch":value} as React.CSSProperties} aria-label={`ペンの色 ${value}`} aria-pressed={color===value} onClick={()=>{setColor(value);setTool("pen");}}/>)}<label className="custom-color" title="好きな色を選ぶ"><span className="sr-only">好きなペンの色</span><input type="color" value={color} onChange={event=>{setColor(event.target.value);setTool("pen");}}/></label></div>
            <span className="tool-divider"/><label className="brush-size"><span>太さ</span><input type="range" min="1" max="40" step="1" value={width} onChange={event=>setWidth(Number(event.target.value))}/><output>{width}</output></label>
            <div className="history-tools"><button className="icon-button" aria-label="描画を元に戻す" title="元に戻す（Ctrl / ⌘ Z）" disabled={!editor.strokes.length||deleted||drawing} onClick={()=>changeHistory("undo")}><Icon name="undo"/></button><button className="icon-button" aria-label="描画をやり直す" title="やり直す（Ctrl / ⌘ Shift Z）" disabled={!redo.length||deleted||drawing} onClick={()=>changeHistory("redo")}><Icon name="redo"/></button></div>
          </div>
          <div className={`paper-wrap ${deleted?"deleted-paper":""}`}><DrawingCanvas strokes={editor.strokes} tool={tool} color={color} width={width} disabled={!ready||deleted} onStroke={append} onDrawingChange={setDrawing} onLimit={()=>setError("この紙の描画上限に達しました。ここまでの線は残っています。保存して、新しいスケッチを作ってください。")}/>{!editor.strokes.length&&<span className="paper-placeholder"><span>＋</span>ここから、ひと筆。</span>}</div>
          <div className="paper-footer"><span>1200 × 800 <i>·</i> {editor.strokes.length} strokes</span><span>ペン・指・マウスで描けます</span></div>
        </section>
        <div className="below-paper"><div className="space-chips" aria-label="このスケッチのスペース">{data.spaces.map(space=><button className={`chip ${editor.spaceIds.includes(space.id)?"selected":""}`} key={space.id} disabled={!ready||deleted} onClick={()=>mutate({spaceIds:editor.spaceIds.includes(space.id)?editor.spaceIds.filter(id=>id!==space.id):[...editor.spaceIds,space.id]})}><i style={{background:space.color}}/>{space.name}</button>)}<button className="add-space" onClick={()=>setModal("settings")} aria-label="スペースを追加"><Icon name="plus" size={14}/></button></div><div className="save-actions">{selected&&!deleted&&organization.itemButton(selected.id)}{selected&&<button className="icon-button" aria-label={deleted?"スケッチを復元":"スケッチをごみ箱へ"} disabled={busy||saving||dirty||drawing} onClick={()=>void perform(()=>trash(selected))}><Icon name={deleted?"undo":"trash"}/></button>}<button className="button" disabled={!ready||busy||drawing} onClick={()=>void perform(async guard=>{const captured=structuredClone(editorRef.current);const blob=await drawingPng(captured.strokes);if(guard.current())download(blob,`${captured.title.trim()||"sketch"}.png`);})}><Icon name="download" size={16}/><span>PNG（暗号化なし）</span></button>{deleted?<button className="button primary" disabled={busy||saving} onClick={()=>selected&&void perform(()=>trash(selected))}>ごみ箱から戻す</button>:<button className="button primary" disabled={!ready||saving||drawing||(!dirty&&!!editor.editingId)} onClick={()=>void save()}><Icon name="save" size={16}/>{saving?"保存中…":"スケッチを保存"}</button>}</div></div>
        <section className="inspiration"><div className="section-heading"><h2><Icon name="link" size={16}/>着想のつながり</h2><button disabled={!ready||deleted||busy} onClick={()=>{setSourceSearch("");setModal("sources");}}><Icon name="plus" size={13}/>Recallのメモを関連付ける</button></div>{sourceNotes.length||pendingSource?<div className="source-list">{sourceNotes.map(({relation,note})=><div className="source-card" key={relation.id}><span className="source-label">INSPIRED BY</span>{note?<a href={`/recall/?item=${encodeURIComponent(note.id)}`} onClick={event=>appLink(event,`/recall/?item=${encodeURIComponent(note.id)}`)}><span>{titleOf(note)}</span><small>{note.deletedAt?"ごみ箱のメモ":"Recallで開く"}<Icon name="arrow" size={12}/></small></a>:<p>元のメモを同期すると表示できます</p>}<button className="icon-button" title="関連付けを解除" aria-label="この関連付けを解除" onClick={()=>void perform(()=>removeSource(relation))} disabled={busy}><Icon name="close" size={14}/></button></div>)}{pendingSource&&<div className="source-card pending-source"><span className="source-label">INSPIRED BY</span><p>{liveNotes.find(note=>note.id===pendingSource)?titleOf(liveNotes.find(note=>note.id===pendingSource)!):"選択したメモ"}<small>スケッチを保存すると関連付きます</small></p><button className="icon-button" aria-label="着想元の選択を取り消す" onClick={()=>setPendingSource("")}><Icon name="close" size={14}/></button></div>}</div>:<p className="inspiration-empty">関連するRecallのメモを追加できます。</p>}</section>
        {view==="trash"&&<p className="small-note">ごみ箱へ移してから1か月後の同時刻（日本時間）に完全に削除します。翌月に同じ日がない場合は月末です。期限前に戻すと削除を取り消せます。</p>}
        <SectionHeading title={view==="trash"?"ごみ箱":"すべてのスケッチ"} count={shown.length}/><RecordGrid>{shown.length?shown.map(sketch=><button className={`gallery-card ${editor.editingId===sketch.id?"selected":""}`} key={sketch.id} onClick={()=>open(sketch)}><SketchThumbnail strokes={sketch.strokes} label={`${sketch.title||"無題のスケッチ"}を開く`}/><span className="gallery-meta"><strong>{sketch.title||"無題のスケッチ"}</strong><time>{date(sketch.updatedAt)}</time></span>{cloud.pendingItemIds.includes(sketch.id)&&<span className="gallery-pending">同期待ち</span>}</button>):<div className="gallery-empty"><Icon name="pen" size={26}/><p>{view==="trash"?"ごみ箱は空です":"スケッチがありません"}</p></div>}</RecordGrid>
        <footer className="page-footer"><span>{offline?"オフライン · 端末への保存は続けられます":"スケッチを保存・編集"}</span><span>{dirty?"下書きはこのブラウザに保存されます":"Sketchbook"}</span></footer>

    {notice&&<div className="toast" role="status"><Icon name="check" size={16}/>{notice}</div>}
    {modal==="sources"&&<Modal title="着想元のメモを選ぶ" onClose={()=>setModal(null)}><p className="muted">Recallのメモをそのまま参照します。本文のコピーは作りません。</p><input className="text-input" type="search" autoFocus placeholder="メモのことばで探す" aria-label="着想元のメモを探す" value={sourceSearch} onChange={event=>setSourceSearch(event.target.value)}/><div className="note-picker">{liveNotes.filter(note=>note.body.normalize("NFKC").includes(sourceSearch.normalize("NFKC"))&&!activeRelations.some(relation=>relation.toItemId===note.id)).map(note=><button key={note.id} disabled={busy} onClick={()=>void perform(()=>addSource(note))}><p>{titleOf(note)}</p><small>{date(note.updatedAt)} <Icon name="plus" size={13}/></small></button>)}{!liveNotes.length&&<p className="muted">この保存先にメモがありません。Recallでメモを残すと、ここから選べます。</p>}</div></Modal>}
    {modal==="settings"&&<Modal title="保存とアカウント" onClose={()=>setModal(null)}><VaultRetentionSettings/><hr/>{organization.spaceSettings}<hr/>
      <h3>クラウド同期</h3>{!cloud.configured?<p className="muted">クラウドの接続設定がありません。いまは端末内モードを使えます。</p>:!cloud.authReady?<p className="muted">ログイン状態を確認しています…</p>:cloud.user?<><p className="account-email">{cloud.user.email??"ログイン済み"}</p><p className="muted">{cloud.identity.mode==="account"?"Recallと同じアカウントのデータを開いています。":"端末内モードを開いています。アカウントのデータとは別の保存先です。"}</p><div className="modal-buttons">{cloud.identity.mode==="account"?<><button className="button" onClick={()=>void cloud.runSync()} disabled={cloud.syncStatus.phase==="syncing"}>今すぐ同期</button><button className="button" onClick={()=>navigate(()=>void cloud.useDevice())}>端末内のノートを開く</button></>:<button className="button" onClick={()=>navigate(()=>void cloud.useAccount())}>アカウントのノートを開く</button>}<button className="button" disabled={cloud.authBusy} onClick={()=>navigate(()=>void cloud.signOut())}>このブラウザの全ツールからログアウト</button></div>{cloud.identity.mode==="account"&&<><p className="muted">同期待ち {cloud.syncStatus.pending}件 · 競合 {cloud.conflicts.length}件</p>{cloud.syncStatus.phase==="error"&&<p className="warning-note">原本の同期が完了していません。端末には残っています。</p>}{(pendingPreviews>0||failedPreviews>0)&&<p className="warning-note">原本とは別に、プレビュー画像 {pendingPreviews}件を準備中、{failedPreviews}件は再送が必要です。<button className="text-button" onClick={retryPreviews} disabled={!failedPreviews}>画像を再送する</button></p>}{cloud.localCount>0&&<div className="import-local"><h4>端末内のスケッチを取り込む</h4><p className="muted">{cloud.localCount}枚をこのアカウントにコピーします。元のスケッチは残ります。着想元への関連付けはコピーしません。繰り返すと追加されます。</p><button className="button" disabled={busy} onClick={()=>void perform(async guard=>{const result=await cloud.importDevice();if(guard.current()&&result)setNotice(`${result.sketches}枚を取り込みました`);})}>{cloud.localCount}枚を取り込む</button></div>}</>}</>:<><GoogleSignInButton disabled={cloud.authBusy}/><details style={{marginTop:16}}><summary>メールでログイン</summary><form className="login-form" onSubmit={event=>{event.preventDefault();void cloud.signIn(email);}}><p className="muted">Recallと共通のメールログインです。届いたリンクをこのブラウザで開くとRecallに戻ります。そこからSketchbookを開いてください。</p><label htmlFor="login-email">メールアドレス</label><input id="login-email" className="text-input" type="email" value={email} onChange={event=>setEmail(event.target.value)} autoComplete="email" required/><button className="button primary" type="submit" disabled={cloud.authBusy||!email.trim()}>{cloud.authBusy?"送信中…":"ログインメールを送る"}</button></form></details></>}
      {cloud.authMessage&&<p className="auth-message" role="status">{cloud.authMessage}</p>}
      {cloud.conflicts.length>0&&<section className="conflict-list"><h3>別の変更が見つかりました</h3><p className="muted">「両方残す」は端末のスケッチを別の一枚として保存します。メモの競合はRecallからも確認できます。</p>{cloud.conflicts.map(conflict=><article key={conflict.id} className="conflict-card"><div className="conflict-versions"><div><h4>この端末の版</h4><Version record={conflict.local}/></div><div><h4>クラウドの版</h4><Version record={conflict.remote}/></div></div><div className="modal-buttons"><button className="button primary" disabled={busy} onClick={()=>void perform(async guard=>{await cloud.resolveConflict(conflict.id,"keep_both");if(guard.current())setNotice("両方の版を残しました");})}>両方残す</button><button className="button" disabled={busy} onClick={()=>void perform(()=>cloud.resolveConflict(conflict.id,"keep_remote"))}>クラウドの版を使う</button></div></article>)}</section>}
      <hr/><h3>スペース</h3><form className="space-form" onSubmit={event=>{event.preventDefault();void perform(async guard=>{await guard.repo?.createSpace(spaceName);if(guard.current()){setSpaceName("");setNotice("スペースを追加しました");}});}}><input className="text-input" aria-label="新しいスペース名" maxLength={40} placeholder="新しいスペース名" value={spaceName} onChange={event=>setSpaceName(event.target.value)}/><button className="button" disabled={busy||!spaceName.trim()}>追加</button></form>
      <hr/><h3>バックアップ</h3><p className="muted">この保存先のスケッチとスペースを書き出します。下書きとメモへの関連付けは含みません。読み込みは別の一枚として追加するため、繰り返すと重複します。</p><div className="modal-buttons"><button className="button" disabled={busy||!ready} onClick={()=>void perform(async guard=>{if(!guard.repo)return;const backup=await guard.repo.exportSketchBackup();if(guard.current())download(new Blob([await encryptBackup(backup)],{type:"application/json"}),`sketchbook-${new Date().toISOString().slice(0,10)}.json`);})}>暗号化バックアップを書き出す</button><button className="button" disabled={busy||!ready} onClick={()=>importInput.current?.click()}>JSONを追加読み込み</button></div><input ref={importInput} type="file" accept="application/json,.json" hidden onChange={event=>{const file=event.target.files?.[0];event.target.value="";if(!file)return;void perform(async guard=>{if(file.size>100*1024*1024)throw new Error("100MB以内のJSONファイルを選んでください。");const text=await file.text();if(!guard.current()||!guard.repo)return;const result=await guard.repo.importSketchBackup(await decryptBackup(JSON.parse(text)));if(guard.current())setNotice(`${result.sketches}枚を追加しました`);});}}/>
      <hr/><h3>端末への保存</h3><p className="muted">{pwaState}</p><p className="muted">ブラウザのデータを消すと、未同期のスケッチと下書きも消えます。大切なものはバックアップを残してください。</p><button className="button" onClick={()=>void perform(async guard=>{const granted=await navigator.storage?.persist?.();if(guard.current())setNotice(granted?"保存領域の保護が有効です":"保存領域の保護はブラウザが判断します");})}>保存領域の保護を依頼する</button>
    </Modal>}
    {pendingNavigation&&<Modal title="描きかけの変更があります" onClose={()=>setPendingNavigation(null)}><p className="muted">このスケッチを保存してから移動できます。</p><div className="modal-buttons"><button className="button primary" disabled={saving||drawing} onClick={()=>void(async()=>{const move=pendingNavigation;if(await save()){setPendingNavigation(null);move();}})()}>保存して移動</button><button className="button" disabled={saving} onClick={()=>void(async()=>{const move=pendingNavigation,guard=context();try{await queueDraft(blank(),"");if(guard.current()){setPendingNavigation(null);move();}}catch(value){if(guard.current())failure(value);}})()}>変更を破棄して移動</button><button className="button" onClick={()=>setPendingNavigation(null)}>描き続ける</button></div></Modal>}
  {organization.dialogs}</SuiteShell>;
}
