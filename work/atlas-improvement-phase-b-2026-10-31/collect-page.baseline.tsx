"use client";
import {encryptBackup,decryptBackup,beforeVaultLock,consumeLegacyVaultShare} from "@personal-tools/api-client";
import {useEffect,useRef,useState,type ClipboardEvent,type DragEvent,type MouseEvent} from "react";
import type {CollectDraft,Resource,ResourceMetadataJob,SyncRecord} from "@personal-tools/core";
import {ConflictError,prepareResourceImage,uploadEncryptedResourceOriginal as uploadResourceOriginal,downloadEncryptedResourceOriginal as downloadResourceOriginal,type RecallRepository} from "@personal-tools/api-client";
import {getBrowserAuthClient} from "@personal-tools/auth/browser";
import {usePersonalToolsCloud,type CloudSnapshot} from "@personal-tools/auth/react";
import {blankCapture,captureFingerprint,draftFor,displayTitle,hostname,imageCaptureFields,initialCapture,matchesResource,mergeShareCapture,prettyBytes,readShareCapture,rebaseMetadataDraft,safeLink,withoutShareParams,type ShareCapture} from "./capture";
import {saveCaptureResource} from "./draft-save";
import {clipboardImage} from "./clipboard";
import {EmptyCollection,Icon,Modal,type IconName} from "./components";

const EMPTY:CloudSnapshot={notes:[],spaces:[],sketches:[],relations:[],resources:[],projects:[],labels:[]};
type View="inbox"|"all"|"image"|"link"|"trash";
type FileState={url?:string;status:"local"|"loading"|"remote"|"pending"|"uploaded"|"error"};
const day=(value:string)=>new Intl.DateTimeFormat("ja-JP",{month:"short",day:"numeric"}).format(new Date(value));
const fileKey=(resource:Resource)=>`${resource.id}:${resource.image?.sha256??""}`;
const fileName=(resource:Resource)=>resource.image?.filename||"collect-original";
function download(blob:Blob,name:string){const url=URL.createObjectURL(blob),anchor=document.createElement("a");anchor.href=url;anchor.download=name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
function Version({record}:{record:SyncRecord}){
  if("kind" in record&&record.kind==="resource")return <p className="version-text">{displayTitle(record)}{record.deletedAt?"（ごみ箱）":""}{"\n"}{record.url??record.sourceUrl??record.image?.filename}{"\n"}{record.memo}</p>;
  if("body" in record)return <p className="version-text">{record.body}</p>;
  if("name" in record)return <p className="version-text">{record.name}</p>;
  if("title" in record)return <p className="version-text">{record.title}</p>;
  return <p className="version-text">記録同士のつながり</p>;
}

export default function Collect(){
  const repository=useRef<RecallRepository|null>(null),epoch=useRef(0),revision=useRef(0),selection=useRef(0),draftQueue=useRef(Promise.resolve()),leaving=useRef(false);
  const [data,setData]=useState<CloudSnapshot>(EMPTY),[ready,setReady]=useState(false),[draft,setDraft]=useState<CollectDraft>(blankCapture);
  const draftRef=useRef(draft);draftRef.current=draft;
  const [draftBlob,setDraftBlob]=useState<Blob|null>(null),draftBlobRef=useRef<Blob|null>(null),[draftPreview,setDraftPreview]=useState("");
  const [baseline,setBaseline]=useState(()=>captureFingerprint(blankCapture())),[draftSaved,setDraftSaved]=useState(true);
  const baselineResource=useRef<Resource|undefined>(undefined);
  const [view,setView]=useState<View>("inbox"),[spaceFilter,setSpaceFilter]=useState(""),[query,setQuery]=useState("");
  const [error,setError]=useState(""),[notice,setNotice]=useState(""),[saving,setSaving]=useState(false),[busy,setBusy]=useState(false),[selecting,setSelecting]=useState(false),[dragging,setDragging]=useState(false),[saveConflict,setSaveConflict]=useState(false);
  const [settings,setSettings]=useState(false),[pendingNavigation,setPendingNavigation]=useState<(()=>void)|null>(null),[incomingShare,setIncomingShare]=useState<ShareCapture|null>(null);
  const [email,setEmail]=useState(""),[spaceName,setSpaceName]=useState(""),[pwaState,setPwaState]=useState(""),[offline,setOffline]=useState(false);
  const [duplicates,setDuplicates]=useState<Resource[]>([]),[files,setFiles]=useState<Record<string,FileState>>({}),[fileRetry,setFileRetry]=useState(0);
  const fileInput=useRef<HTMLInputElement>(null),backupInput=useRef<HTMLInputElement>(null),captureArea=useRef<HTMLElement>(null),urlInput=useRef<HTMLInputElement>(null);
  const objectUrls=useRef(new Map<string,string>()),uploads=useRef(new Set<string>()),loadingFiles=useRef(new Map<string,Promise<Blob|null>>());
  const metadataRequests=useRef(new Map<string,AbortController>()),metadataAttempted=useRef(new Set<string>());
  const dirty=captureFingerprint(draft)!==baseline;
  function context(){const repo=repository.current,at=epoch.current;return {repo,current:()=>repo===repository.current&&at===epoch.current};}
  function failure(value:unknown){setError(value instanceof Error?value.message:"処理を完了できませんでした。入力は残しています。");}
  function setBlob(blob:Blob|null){draftBlobRef.current=blob;setDraftBlob(blob);}
  function installDraft(next:CollectDraft,saved?:Resource,blob:Blob|null=null){
    revision.current++;selection.current++;draftRef.current=structuredClone(next);setDraft(draftRef.current);setBlob(blob);
    baselineResource.current=saved?.localRevision===next.expectedRevision?saved:undefined;
    setBaseline(captureFingerprint(saved?draftFor(saved):blankCapture()));setDraftSaved(false);setError("");setSaveConflict(false);
  }
  function clearFiles(){for(const url of objectUrls.current.values())URL.revokeObjectURL(url);objectUrls.current.clear();uploads.current.clear();loadingFiles.current.clear();setFiles({});}
  const cloud=usePersonalToolsCloud({
    reset(){
      epoch.current++;revision.current++;selection.current++;repository.current=null;draftRef.current=blankCapture();setDraft(draftRef.current);setBlob(null);
      baselineResource.current=undefined;draftQueue.current=Promise.resolve();leaving.current=false;
      setBaseline(captureFingerprint(blankCapture()));setData(EMPTY);setReady(false);setSaving(false);setBusy(false);setSelecting(false);setSaveConflict(false);
      setView("inbox");setSpaceFilter("");setQuery("");setError("");setNotice("");setDuplicates([]);setPendingNavigation(null);setIncomingShare(null);setEmail("");setSpaceName("");clearFiles();
      for(const controller of metadataRequests.current.values())controller.abort();metadataRequests.current.clear();metadataAttempted.current.clear();
    },
    ready(repo,snapshot,recovered){
      const at=epoch.current;repository.current=repo;setData(snapshot);
      const requestedId=new URL(window.location.href).searchParams.get("item"),initial=initialCapture(recovered,snapshot.resources,requestedId),next=initial.draft;
      installDraft(next,initial.saved);
      if(initial.restored)setNotice("収集の下書きを復元しました");
      setIncomingShare(readShareCapture(consumeLegacyVaultShare()??window.location.search));
      void repo.getCollectDraftFile().then(blob=>{
        if(at!==epoch.current||repository.current!==repo)return;
        if(initial.restoreFile&&blob)setBlob(blob);setReady(true);setDraftSaved(true);
      }).catch(value=>{if(at===epoch.current&&repository.current===repo){setReady(true);failure(value);}});
    },
    snapshot(snapshot){setData(snapshot);},failure,
  },{app:"collect"});
  const latest=useRef({data,identity:cloud.identity,pending:cloud.pendingItemIds,conflicts:cloud.conflicts});latest.current={data,identity:cloud.identity,pending:cloud.pendingItemIds,conflicts:cloud.conflicts};
  const selected=data.resources.find(resource=>resource.id===draft.editingId),deleted=!!selected?.deletedAt,stale=!!selected&&selected.localRevision!==draft.expectedRevision;
  const locked=!ready||saving||busy||selecting;
  const shown=data.resources.filter(resource=>
    (view==="trash"?!!resource.deletedAt:!resource.deletedAt)&&
    (view!=="inbox"||resource.inbox)&&(view!=="image"&&view!=="link"||resource.resourceType===view)&&
    (!spaceFilter||resource.spaceIds.includes(spaceFilter))&&matchesResource(resource,query),
  ).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const activeImages=data.resources.filter(resource=>!resource.deletedAt&&resource.image);
  const pendingFiles=cloud.identity.mode==="account"?activeImages.filter(resource=>["pending","loading"].includes(files[fileKey(resource)]?.status??"")).length:0;
  const failedFiles=cloud.identity.mode==="account"?activeImages.filter(resource=>files[fileKey(resource)]?.status==="error").length:0;
  const status=!ready?"読み込み中…":cloud.identity.mode==="device"?"端末内モード":cloud.syncStatus.phase==="syncing"?"記録を同期中…":cloud.syncStatus.phase==="error"?"同期を確認してください":cloud.conflicts.length?"競合の確認が必要":cloud.syncStatus.pending?`記録の同期待ち ${cloud.syncStatus.pending}件`:pendingFiles?`記録同期済み · 画像${pendingFiles}件待ち`:failedFiles?"記録同期済み · 画像の再送が必要":"記録は同期済み";

  function mutate(change:Partial<CollectDraft>){revision.current++;setDraftSaved(false);const next={...draftRef.current,...change};draftRef.current=next;setDraft(next);}
  useEffect(()=>beforeVaultLock(()=>queueDraft(structuredClone(draftRef.current),draftBlobRef.current)),[]);
  function queueDraft(next:CollectDraft,blob=draftBlobRef.current){
    const guard=context();if(!guard.repo)return Promise.resolve();
    draftQueue.current=draftQueue.current.catch(()=>{}).then(async()=>{
      if(!guard.current())return;await guard.repo!.saveCollectDraft(next,blob);
      if(guard.current()&&captureFingerprint(draftRef.current)===captureFingerprint(next))setDraftSaved(true);
    });return draftQueue.current;
  }
  useEffect(()=>{if(!ready)return;const guard=context(),at=revision.current,timer=setTimeout(()=>{if(!guard.current()||at!==revision.current)return;void queueDraft(structuredClone(draft)).catch(value=>{if(guard.current()){setDraftSaved(false);failure(value);}});},250);return()=>clearTimeout(timer);},[draft,draftBlob,ready]);
  useEffect(()=>{
    if(!selected||!stale||saving||selecting)return;
    const rebased=baselineResource.current?rebaseMetadataDraft(draftRef.current,baselineResource.current,selected):null;
    if(rebased){revision.current++;baselineResource.current=selected;draftRef.current=rebased;setDraft(rebased);setDraftSaved(false);return;}
    if(dirty)return;
    const blob=selected.image?.sha256===draftRef.current.image?.sha256?draftBlobRef.current:null;
    installDraft(draftFor(selected),selected,blob);
  },[selected,stale,dirty,saving,selecting]);
  useEffect(()=>{
    if(!draftBlob){setDraftPreview("");return;}
    // Object URLs stay local to this mounted view; release them on replacement/logout.
    // https://developer.mozilla.org/en-US/docs/Web/API/URL/revokeObjectURL_static
    const url=URL.createObjectURL(draftBlob);setDraftPreview(url);return()=>URL.revokeObjectURL(url);
  },[draftBlob]);
  useEffect(()=>{
    if(!ready)return;const guard=context();let active=true;
    void guard.repo?.duplicateResources({url:draft.resourceType==="link"?draft.url:null,image:draft.image},draft.editingId).then(result=>{if(active&&guard.current())setDuplicates(result);}).catch(()=>{if(active&&guard.current())setDuplicates([]);});
    return()=>{active=false;};
  },[draft.url,draft.image,draft.resourceType,draft.editingId,data.resources,ready]);
  useEffect(()=>{
    const changed=()=>{setOffline(!navigator.onLine);if(navigator.onLine)setFileRetry(value=>value+1);};changed();window.addEventListener("online",changed);window.addEventListener("offline",changed);
    return()=>{window.removeEventListener("online",changed);window.removeEventListener("offline",changed);};
  },[]);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(""),6000);return()=>clearTimeout(timer);},[notice]);
  useEffect(()=>{if(!dirty)return;const before=(event:BeforeUnloadEvent)=>{if(!leaving.current)event.preventDefault();};window.addEventListener("beforeunload",before);return()=>window.removeEventListener("beforeunload",before);},[dirty]);
  useEffect(()=>{
    if(process.env.NODE_ENV!=="production"||!("serviceWorker" in navigator)){setPwaState("オフライン起動は本番モードで準備します");return;}
    let active=true;navigator.serviceWorker.register("/collect/sw.js",{scope:"/collect/"}).then(async registration=>{await navigator.serviceWorker.ready;if(active)setPwaState(registration.active?"オフライン起動の準備完了":"次回の起動でオフラインに対応します");}).catch(()=>{if(active)setPwaState("オフライン用画面の準備を確認できませんでした");});return()=>{active=false;};
  },[]);
  useEffect(()=>()=>{epoch.current++;for(const controller of metadataRequests.current.values())controller.abort();for(const url of objectUrls.current.values())URL.revokeObjectURL(url);},[]);

  function installFileUrl(resource:Resource,blob:Blob,status:FileState["status"]){
    const key=fileKey(resource);let url=objectUrls.current.get(key);if(!url){url=URL.createObjectURL(blob);objectUrls.current.set(key,url);}
    setFiles(current=>({...current,[key]:{url,status}}));
  }
  async function original(resource:Resource,allowRemote=true):Promise<Blob|null>{
    const guard=context();if(!guard.repo||!resource.image)return null;
    const key=fileKey(resource),pending=loadingFiles.current.get(key);
    if(pending){const blob=await pending;if(blob||!allowRemote||!guard.current())return blob;if(loadingFiles.current.get(key)===pending)loadingFiles.current.delete(key);return original(resource,true);}
    const work=(async()=>{
      let blob=await guard.repo!.getResourceFile(resource.id);if(!guard.current())return null;
      if(blob){installFileUrl(resource,blob,cloud.identity.mode==="device"?"local":files[key]?.status==="uploaded"?"uploaded":"local");return blob;}
      if(!allowRemote){setFiles(current=>({...current,[key]:{status:"remote"}}));return null;}
      const identity=latest.current.identity,auth=getBrowserAuthClient();
      if(identity.mode!=="account"||!auth||resource.ownerId!==identity.userId||!resource.serverRevision)throw new Error("原本の画像がこの端末にありません。元の端末で同期してから、もう一度お試しください。");
      setFiles(current=>({...current,[key]:{...current[key],status:"loading"}}));
      blob=await downloadResourceOriginal(auth,identity.userId,resource,{isCurrent:guard.current});if(!guard.current())return null;
      await guard.repo!.cacheResourceFile(resource.id,blob);if(!guard.current())return null;
      installFileUrl(resource,blob,"uploaded");uploads.current.add(key);return blob;
    })();
    loadingFiles.current.set(key,work);
    try{return await work;}catch(value){if(guard.current())setFiles(current=>({...current,[key]:{...current[key],status:"error"}}));throw value;}
    finally{if(loadingFiles.current.get(key)===work)loadingFiles.current.delete(key);}
  }
  useEffect(()=>{
    if(!ready)return;const guard=context();
    void(async()=>{for(const resource of shown.slice(0,60)){if(!guard.current())break;const key=fileKey(resource);if(resource.image&&!files[key])await original(resource,false).catch(()=>{});}})();
  },[shown.map(resource=>fileKey(resource)).join("|"),ready]);
  useEffect(()=>{
    if(!ready||cloud.identity.mode!=="account")return;
    const guard=context(),owner=cloud.identity.userId,auth=getBrowserAuthClient();if(!auth)return;
    const candidates=data.resources.filter(resource=>resource.image&&!resource.deletedAt&&resource.serverRevision&&!cloud.pendingItemIds.includes(resource.id)&&!cloud.conflicts.some(conflict=>conflict.entityId===resource.id));
    void(async()=>{for(const resource of candidates){
      if(!guard.current())break;const key=fileKey(resource);if(uploads.current.has(key))continue;uploads.current.add(key);
      try{
        const blob=await guard.repo!.getResourceFile(resource.id);if(!guard.current())break;
        if(!blob){setFiles(current=>({...current,[key]:{...current[key],status:"remote"}}));continue;}
        const current=latest.current.data.resources.find(item=>item.id===resource.id);
        if(!current||current.deletedAt||current.image?.sha256!==resource.image?.sha256||latest.current.pending.includes(resource.id)){uploads.current.delete(key);continue;}
        setFiles(state=>({...state,[key]:{...state[key],status:"pending"}}));
        await uploadResourceOriginal(auth,owner,current,blob,{isCurrent:guard.current});if(!guard.current())break;
        installFileUrl(current,blob,"uploaded");
      }catch{if(guard.current())setFiles(current=>({...current,[key]:{...current[key],status:"error"}}));}
    }})();
  },[data.resources,cloud.identity,cloud.pendingItemIds,cloud.conflicts,ready,fileRetry]);

  async function chooseFile(file:File|undefined){
    if(!file||locked||draft.editingId)return;const guard=context(),attempt=++selection.current;setSelecting(true);setError("");
    try{const image=await prepareResourceImage(file,file.name);if(!guard.current()||attempt!==selection.current)return;const fields=imageCaptureFields(draftRef.current);setBlob(file);mutate({...fields,image});}
    catch(value){if(guard.current()&&attempt===selection.current)failure(value);}
    finally{if(guard.current()&&attempt===selection.current){setSelecting(false);if(fileInput.current)fileInput.current.value="";}}
  }
  function pasteImage(event:ClipboardEvent<HTMLElement>){
    let file:File|null;
    try{file=clipboardImage(event.clipboardData);}catch(value){event.preventDefault();failure(value);return;}
    if(!file)return;
    event.preventDefault();
    if(locked||deleted)return;
    if(draftRef.current.editingId){setNotice("画像を追加するには「新しい収集」を開いてください。編集中の内容は残しています。");return;}
    if(draftRef.current.image){setNotice("画像が選択されています。別の画像を貼り付けるには、先に「画像を外す」を押してください。");return;}
    void chooseFile(file);
  }
  function drop(event:DragEvent<HTMLElement>){event.preventDefault();setDragging(false);if(!locked)void chooseFile(event.dataTransfer.files[0]);}
  async function save(asCopy=false):Promise<boolean>{
    const guard=context();if(!guard.repo||locked||deleted&&!asCopy)return false;
    const captured=structuredClone(draftRef.current),capturedRevision=revision.current,sourceId=captured.editingId;
    if(asCopy){delete captured.editingId;delete captured.expectedRevision;}
    setSaving(true);setError("");
    try{
      let blob=draftBlobRef.current;
      if(captured.image&&!captured.editingId&&!blob&&sourceId){const source=latest.current.data.resources.find(resource=>resource.id===sourceId);if(source)blob=await original(source);}
      if(!guard.current())return false;
      const saved=await saveCaptureResource(guard.repo,captured,blob,asCopy?undefined:baselineResource.current,guard.current);
      if(!saved||!guard.current())return false;
      if(capturedRevision===revision.current){
        if(sourceId&&!asCopy){installDraft(draftFor(saved),saved,blob);await queueDraft(draftFor(saved),blob);}
        else{installDraft(blankCapture());await queueDraft(blankCapture(),null);}
      }else{const next={...draftRef.current,editingId:saved.id,expectedRevision:saved.localRevision};draftRef.current=next;setDraft(next);setBaseline(captureFingerprint(draftFor(saved)));await queueDraft(next);}
      if(!guard.current())return false;
      const url=new URL(window.location.href);if(sourceId&&!asCopy)url.searchParams.set("item",saved.id);else url.searchParams.delete("item");window.history.replaceState(null,"",url.pathname+url.search);
      setNotice(asCopy?"手元の内容を別の収集として保存しました":sourceId?"変更を保存しました":"収集箱に保存しました");

      return true;
    }catch(value){if(guard.current()){failure(value);if(value instanceof ConflictError)setSaveConflict(true);}return false;}
    finally{if(guard.current())setSaving(false);}
  }
  async function perform(work:(guard:ReturnType<typeof context>)=>Promise<void>){if(busy)return;const guard=context();setBusy(true);try{await work(guard);}catch(value){if(guard.current())failure(value);}finally{if(guard.current())setBusy(false);}}
  function navigate(work:()=>void){if(locked)return;if(dirty){setPendingNavigation(()=>work);return;}const guard=context();void queueDraft(draftRef.current).then(()=>{if(guard.current())work();}).catch(value=>{if(guard.current())failure(value);});}
  function showResource(resource:Resource){navigate(()=>{
    installDraft(draftFor(resource),resource);const url=new URL(window.location.href);url.searchParams.set("item",resource.id);window.history.replaceState(null,"",url.pathname+url.search);captureArea.current?.scrollIntoView({behavior:"smooth",block:"start"});
    if(resource.image){const guard=context();void original(resource).then(blob=>{if(guard.current()&&draftRef.current.editingId===resource.id&&draftRef.current.image?.sha256===resource.image?.sha256)setBlob(blob);}).catch(value=>{if(guard.current())failure(value);});}
  });}
  function newCapture(){navigate(()=>{installDraft(blankCapture());const url=new URL(window.location.href);url.searchParams.delete("item");window.history.replaceState(null,"",url.pathname+url.search);captureArea.current?.scrollIntoView({behavior:"smooth",block:"start"});urlInput.current?.focus();});}
  function appLink(event:MouseEvent<HTMLAnchorElement>,href:string){if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||event.button!==0)return;event.preventDefault();navigate(()=>{leaving.current=true;window.location.href=href;});}
  async function update(resource:Resource,changes:Partial<Pick<Resource,"inbox"|"pinned"|"deletedAt">>){
    const guard=context();if(!guard.repo)return;const saved=await guard.repo.updateResource(resource.id,changes,resource.localRevision);if(!guard.current())return;
    if(draftRef.current.editingId===resource.id&&!dirty)installDraft(draftFor(saved),saved,draftBlobRef.current);
    setNotice(changes.deletedAt===null?"収集を戻しました":changes.deletedAt?"ごみ箱へ移しました":changes.inbox===false?"整理済みにしました":changes.inbox===true?"収集箱へ戻しました":"保存しました");
  }
  async function backup(ids?:string[]){await perform(async guard=>{
    if(!guard.repo)return;const snapshot=await guard.repo.snapshot();if(!guard.current())return;
    const resources=snapshot.resources.filter(resource=>!ids||ids.includes(resource.id));
    const unique=new Map(resources.filter(resource=>resource.image).map(resource=>[resource.image!.sha256,resource]));
    if([...unique.values()].reduce((total,resource)=>total+resource.image!.size,0)>32*1024*1024)throw new Error("画像の合計が32MBを超えています。各カードの書き出しボタンで、資料ごとに分けて保存してください。");
    for(const resource of unique.values()){await original(resource);if(!guard.current())return;}
    const result=await guard.repo.exportCollectBackup(ids);if(!guard.current())return;
    download(new Blob([await encryptBackup(result)],{type:"application/json"}),`collect-${ids?.length===1?ids[0]+"-":""}${new Date().toISOString().slice(0,10)}.json`);setNotice("画像の原本を含むバックアップを書き出しました");
  });}
  async function importBackup(file:File|undefined){if(!file)return;await perform(async guard=>{
    if(!guard.repo)return;if(file.size>100*1024*1024)throw new Error("100MB以下のCollectバックアップを選んでください。");
    const text=await file.text();if(!guard.current())return;const result=await guard.repo.importCollectBackup(await decryptBackup(JSON.parse(text)));if(guard.current())setNotice(`${result.resources}件を追加しました。元の収集は残っています`);
  });if(backupInput.current)backupInput.current.value="";}
  async function importLocal(){await perform(async guard=>{const result=await cloud.importDevice();if(guard.current()&&result)setNotice(`${result.resources}件をアカウントに追加しました`);});}
  async function acceptShare(){const shared=incomingShare;if(!shared)return;await perform(async guard=>{
    if(!guard.repo)return;const next=mergeShareCapture(structuredClone(draftRef.current),shared);
    mutate(next);setIncomingShare(null);window.history.replaceState(null,"",withoutShareParams(window.location.href));
    await queueDraft(next,draftBlobRef.current);if(!guard.current())return;
    setNotice("共有内容を下書きに追加しました。内容を確認して保存してください");
  });}
  function dismissShare(){setIncomingShare(null);window.history.replaceState(null,"",withoutShareParams(window.location.href));}
  function retryImages(){for(const resource of data.resources){const key=fileKey(resource);if(files[key]?.status==="error")uploads.current.delete(key);}setFileRetry(value=>value+1);}
  function retryOriginal(resource:Resource){const guard=context();uploads.current.delete(fileKey(resource));setFileRetry(value=>value+1);void original(resource).catch(value=>{if(guard.current())failure(value);});}
  const label=view==="inbox"?"収集箱":view==="image"?"画像の資料":view==="link"?"保存したリンク":view==="trash"?"ごみ箱":spaceFilter?data.spaces.find(space=>space.id===spaceFilter)?.name??"すべての収集":"すべての収集";
  const preview=draftPreview||(selected?files[fileKey(selected)]?.url:undefined);

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="/collect/" onClick={event=>{event.preventDefault();newCapture();}}><img src="/collect/icon.svg" alt="" width="36" height="36"/><span>COLLECT</span></a>
      <p className="brand-caption">URLと画像を保存</p>
      <button className="new-capture" onClick={newCapture} disabled={locked}><Icon name="plus" size={17}/>新しい収集</button>
      <nav className="nav" aria-label="収集の一覧">{([["inbox","収集箱","inbox"],["all","すべての収集","grid"],["image","画像","image"],["link","リンク","link"]] as [View,string,IconName][]).map(([key,name,icon])=><button key={key} className={view===key&&!spaceFilter?"active":""} onClick={()=>{setView(key);setSpaceFilter("");}}><Icon name={icon} size={16}/><span>{name}</span><span>{data.resources.filter(resource=>!resource.deletedAt&&(key!=="inbox"||resource.inbox)&&(key!=="image"&&key!=="link"||resource.resourceType===key)).length}</span></button>)}</nav>
      <div className="sidebar-label"><span>スペース</span><button className="icon-button" aria-label="スペースを追加" onClick={()=>setSettings(true)}><Icon name="plus" size={13}/></button></div>
      <nav className="space-nav" aria-label="スペース">{data.spaces.map(space=><button key={space.id} className={spaceFilter===space.id?"active":""} onClick={()=>{setSpaceFilter(space.id);setView("all");}}><i className="space-dot" style={{background:space.color}}/><span>{space.name}</span><span>{data.resources.filter(resource=>!resource.deletedAt&&resource.spaceIds.includes(space.id)).length}</span></button>)}</nav>
      <div className="sidebar-bottom"><nav className="nav"><button className={view==="trash"?"active":""} onClick={()=>{setView("trash");setSpaceFilter("");}}><Icon name="trash" size={16}/><span>ごみ箱</span><span>{data.resources.filter(resource=>resource.deletedAt).length}</span></button></nav><div className="tool-links"><a href="/atlas/" onClick={event=>appLink(event,"/atlas/")}>⌘ Atlas <Icon name="arrow" size={12}/></a><a href="/recall/" onClick={event=>appLink(event,"/recall/")}>◌ Recall <Icon name="arrow" size={12}/></a><a href="/sketchbook/" onClick={event=>appLink(event,"/sketchbook/")}>▱ Sketchbook <Icon name="arrow" size={12}/></a></div><button className="settings-link" onClick={()=>setSettings(true)}><Icon name="settings" size={15}/>保存とアカウント</button></div>
    </aside>
    <main className="main-pane">
      <header className="topbar"><div className="breadcrumb"><span>Personal tools</span><i>/</i><strong>Collect</strong></div><span className="mobile-brand"><img src="/collect/icon.svg" alt="" width="27" height="27"/>COLLECT</span><button className={`status ${failedFiles||cloud.syncStatus.phase==="error"?"warning":""}`} onClick={()=>setSettings(true)}><span className="status-dot"/>{status}</button></header>
      <div className="workspace">
        <div className="page-heading"><div><p className="eyebrow">COLLECT</p><h1>資料を追加</h1></div></div>
        {error&&<div className="error" role="alert"><span>{error}</span><button className="icon-button" aria-label="エラー表示を閉じる" onClick={()=>setError("")}><Icon name="close" size={15}/></button></div>}
        {incomingShare&&<section className="share-note" aria-label="共有された内容"><h3>共有された内容があります</h3><p>{incomingShare.title||incomingShare.url||incomingShare.memo}</p><p className="small-note">いまの入力を残して下書きに追加します。保存するまで収集や外部ページの取得は行いません。</p><div className="notice-buttons"><button className="button primary" disabled={locked} onClick={()=>void acceptShare()}>下書きに追加</button><button className="button" onClick={dismissShare}>今回は閉じる</button></div></section>}
        {(stale||saveConflict)&&dirty&&<div className="warning-note"><p>別の画面でこの収集が更新されました。手元の入力は残っています。</p><div className="notice-buttons"><button className="button primary" disabled={locked} onClick={()=>void save(true)}>別の収集として保存</button><button className="button" disabled={locked} onClick={()=>selected&&showResource(selected)}>最新の保存内容を開く</button></div></div>}
        <section className="composer" aria-label={selected?"収集を編集":"新しい収集"} ref={captureArea} onPaste={pasteImage}>
          <div className="composer-head"><div className="capture-tabs" aria-label="収集するもの"><button className={draft.resourceType==="link"?"active":""} disabled={locked||!!draft.editingId||!!draft.image} onClick={()=>mutate({resourceType:"link",image:null})}><Icon name="link" size={15}/>リンク</button><button className={draft.resourceType==="image"?"active":""} disabled={locked||!!draft.editingId} onClick={()=>{try{mutate(imageCaptureFields(draftRef.current));}catch(value){failure(value);}}}><Icon name="image" size={15}/>画像</button></div><span className="draft-state">{deleted?"ごみ箱の収集":!ready?"読み込み中…":selecting?"画像を確認中…":saving?"保存中…":dirty?draftSaved?"下書きを端末に保存済み":"下書きを保存中…":selected?"保存済み":"新しい収集"}</span></div>
          <div className="capture-content">
            {draft.resourceType==="link"?<label className="url-row"><Icon name="link" size={18}/><span className="sr-only">収集するURL</span><input ref={urlInput} type="url" inputMode="url" aria-label="収集するURL" placeholder="保存するURL" value={draft.url} maxLength={8192} disabled={locked||deleted} onChange={event=>mutate({url:event.target.value})}/></label>:draft.image?<div className="chosen-file">{preview?<img className="draft-preview" src={preview} alt="選択した画像のプレビュー"/>:<div className="file-placeholder"><Icon name="image" size={26}/></div>}<div className="file-info"><strong>{draft.image.filename}</strong><small>{prettyBytes(draft.image.size)} · 原本を保存します</small>{!draft.editingId?<button className="text-button" disabled={locked} onClick={()=>{setBlob(null);mutate({image:null});}}>画像を外す</button>:<span className="small-note">画像を入れ替える場合は、新しい収集を作成してください。</span>}</div></div>:<button className={`file-drop ${dragging?"is-dragging":""}`} disabled={locked||deleted} onClick={()=>fileInput.current?.click()} onDragOver={event=>{event.preventDefault();if(!locked)setDragging(true);}} onDragLeave={()=>setDragging(false)} onDrop={drop}><Icon name="image" size={28}/><span><strong>画像を選ぶ、またはここにドロップ</strong><small>PNG / JPEG / GIF / WebP · 20MBまで · Ctrl / ⌘ + Vで貼り付け</small></span></button>}
            <input className="title-input" aria-label="収集のタイトル" placeholder={selected?.metadata.title||"タイトル（任意）"} value={draft.title} maxLength={300} disabled={locked||deleted} onChange={event=>mutate({title:event.target.value})}/>
            <textarea className="memo-input" aria-label="自分のメモ" placeholder="メモ（任意）" rows={2} maxLength={100000} disabled={locked||deleted} value={draft.memo} onChange={event=>mutate({memo:event.target.value})} onKeyDown={event=>{if((event.ctrlKey||event.metaKey)&&event.key==="Enter"&&!event.nativeEvent.isComposing){event.preventDefault();void save();}}}/>
            <label className="source-field"><span>出典</span><input type="url" aria-label="出典URL" placeholder={draft.resourceType==="image"?"画像の出典URL（任意）":"元のURLと異なるときに入力（任意）"} maxLength={8192} disabled={locked||deleted} value={draft.sourceUrl} onChange={event=>mutate({sourceUrl:event.target.value})}/></label>
          </div>
          {selected&&<div className="edit-options"><label><input type="checkbox" checked={draft.inbox} disabled={locked||deleted} onChange={event=>mutate({inbox:event.target.checked})}/>収集箱に置く</label>{safeLink(selected.sourceUrl??selected.url)&&<a className="source-link" href={safeLink(selected.sourceUrl??selected.url)} target="_blank" rel="noopener noreferrer"><span>{hostname(selected.sourceUrl??selected.url??"")}</span><Icon name="external" size={12}/></a>}</div>}
          <div className="capture-footer"><div className="space-chips" aria-label="収集のスペース">{data.spaces.map(space=><button key={space.id} className={`chip ${draft.spaceIds.includes(space.id)?"selected":""}`} disabled={locked||deleted} aria-pressed={draft.spaceIds.includes(space.id)} onClick={()=>mutate({spaceIds:draft.spaceIds.includes(space.id)?draft.spaceIds.filter(id=>id!==space.id):[...draft.spaceIds,space.id]})}><i className="space-dot" style={{background:space.color}}/>{space.name}</button>)}</div><div className="capture-actions">{selected&&<button className="button" disabled={locked||dirty} onClick={()=>void perform(()=>update(selected,{deletedAt:deleted?null:new Date().toISOString()}))}><Icon name={deleted?"restore":"trash"} size={14}/>{deleted?"戻す":"ごみ箱"}</button>}<span className="hint">Ctrl / ⌘ + Enter</span>{!deleted&&<button className="button primary" disabled={locked||(!draft.url.trim()&&draft.resourceType==="link")||(!draft.image&&draft.resourceType==="image")||!!selected&&!dirty} onClick={()=>void save()}><Icon name={selected?"check":"plus"} size={15}/>{saving?"保存中…":selected?"変更を保存":"収集箱に残す"}</button>}</div></div>
          {selected?.resourceType==="link"&&!deleted&&<div className="metadata-panel"><div className="metadata-heading"><span>{selected.metadata.status==="pending"?"ページの情報を取得しています…":selected.metadata.status==="failed"?"ページの情報を取得できませんでした。URLとメモは保存されています。":selected.metadata.status==="ready"?"ページから取得した情報":"タイトルや説明は手入力できます。"}</span><span className="small-note">URL情報の自動取得は停止中です。</span></div>{selected.metadata.status==="ready"&&<><strong>{selected.metadata.title}</strong>{selected.metadata.description&&<p>{selected.metadata.description}</p>}{selected.metadata.title&&selected.metadata.title!==draft.title&&<button className="text-button" disabled={locked} onClick={()=>mutate({title:selected.metadata.title})}>このタイトルを使う <Icon name="arrow" size={12}/></button>}</>}</div>}
        </section>
        <div className="composer-note"><span>{draft.image?"選んだ画像を原本のまま保存します。":"ページの情報を取得できなくても、URLとメモは残ります。"}</span><span>AI解析はまだ行いません。</span></div>
        {duplicates.length>0&&<div className="duplicate-note" role="status">似た収集が{duplicates.length}件あります。別のメモとして残すこともできます。{duplicates.slice(0,3).map(resource=><button className="text-button" key={resource.id} onClick={()=>showResource(resource)}>{displayTitle(resource)} <Icon name="arrow" size={10}/></button>)}</div>}
        <div className="collection-toolbar"><div className="collection-title"><h2>{label}</h2><span className="count">{shown.length}</span></div><div className="toolbar-right"><select className="mobile-filter" aria-label="収集の表示範囲" value={spaceFilter?`space:${spaceFilter}`:view} onChange={event=>{const value=event.target.value;if(value.startsWith("space:")){setSpaceFilter(value.slice(6));setView("all");}else{setView(value as View);setSpaceFilter("");}}}><option value="inbox">収集箱</option><option value="all">すべての収集</option><option value="image">画像</option><option value="link">リンク</option>{data.spaces.map(space=><option key={space.id} value={`space:${space.id}`}>{space.name}</option>)}<option value="trash">ごみ箱</option></select><label className="search"><Icon name="search" size={15}/><span className="sr-only">収集を検索</span><input type="search" aria-label="収集を検索" value={query} onChange={event=>setQuery(event.target.value)} placeholder="タイトル・メモを検索"/></label></div></div>
        {view==="trash"&&<p className="small-note">ごみ箱から元に戻せます。原本の画像は自動で削除しません。</p>}
        {shown.length?<div className="resource-grid">{shown.slice(0,120).map(resource=>{
          const state=files[fileKey(resource)],link=safeLink(resource.sourceUrl??resource.url),title=displayTitle(resource);
          return <article key={resource.id} className={`resource-card ${draft.editingId===resource.id?"selected":""}`}>
            <button className="card-open" aria-label={`開く: ${title}`} onClick={()=>showResource(resource)}><div className={`card-preview ${resource.image?state?.url?"":"placeholder":"link-preview"}`}>{resource.image?(state?.url?<img src={state.url} alt={resource.title||resource.image.filename} loading="lazy"/>:<><Icon name="image" size={28}/><span>{state?.status==="loading"?"画像を読み込み中…":"選択して原本を読み込む"}</span></>):<><span className="link-avatar">{hostname(resource.url??"").slice(0,1).toUpperCase()}</span><span className="site-name">{hostname(resource.url??"")}</span></>}<span className="type-mark"><Icon name={resource.image?"image":"link"} size={10}/>{resource.image?"IMAGE":"LINK"}</span></div><div className="card-content"><h3>{title}</h3>{resource.memo&&<p className="card-memo">{resource.memo}</p>}{resource.metadata.status==="pending"&&<span className="card-metadata">ページ情報の自動取得は停止中</span>}{resource.metadata.status==="failed"&&<span className="card-metadata">URLとメモは保存済み</span>}</div></button>
            <div className="card-footer"><time dateTime={resource.createdAt}>{day(resource.createdAt)}</time><span className="spacer"/><span className="card-space-dots">{resource.spaceIds.slice(0,3).map(id=>{const space=data.spaces.find(item=>item.id===id);return space?<i className="space-dot" key={id} title={space.name} style={{background:space.color}}/>:null;})}</span>{link&&<a className="icon-button" href={link} target="_blank" rel="noopener noreferrer" aria-label={`出典を開く: ${title}`}><Icon name="external" size={13}/></a>}<button className="icon-button" aria-label={`書き出す: ${title}`} disabled={busy} onClick={()=>void backup([resource.id])}><Icon name="download" size={13}/></button>{resource.deletedAt?<button className="icon-button" aria-label={`戻す: ${title}`} disabled={busy} onClick={()=>void perform(()=>update(resource,{deletedAt:null}))}><Icon name="restore" size={14}/></button>:<button className="icon-button" aria-label={resource.inbox?`整理済みにする: ${title}`:`収集箱へ戻す: ${title}`} disabled={busy} onClick={()=>void perform(()=>update(resource,{inbox:!resource.inbox}))}><Icon name={resource.inbox?"check":"inbox"} size={14}/></button>}</div>
            <div className={`card-transfer ${state?.status==="error"?"error-state":""}`}><span>{cloud.identity.mode==="device"?"端末に保存":cloud.pendingItemIds.includes(resource.id)||!resource.serverRevision?"記録の同期待ち":resource.image?state?.status==="uploaded"?"原本も同期済み":state?.status==="error"?"原本の送信・取得を確認してください":state?.status==="pending"?"原本の送信待ち":state?.status==="remote"?"画像はこの端末には未保存":"原本の同期を確認中":"記録は同期済み"}</span>{resource.image&&state?.status==="error"&&<button onClick={()=>retryOriginal(resource)}>再試行</button>}</div>
          </article>;
        })}</div>:<div className="empty-state"><EmptyCollection/><h3>{query?"一致する資料がありません":view==="trash"?"ごみ箱は空です。":"資料がありません"}</h3><p>{query?"短い言葉や、別のスペースでも探してみてください。":view==="trash"?"ごみ箱に移した資料をここに表示します。":"URLまたは画像を追加してください。"}</p></div>}
        {shown.length>120&&<p className="small-note">新しい120件を表示しています。言葉やスペースで絞り込んでください。</p>}
        <footer className="page-footer"><span>{offline?"オフライン · 端末への保存は続けられます":"URLと画像を保存"}</span><button onClick={()=>setSettings(true)}>保存とバックアップ</button></footer>
      </div>
    </main>
    {notice&&<div className="toast" role="status"><Icon name="check" size={15}/>{notice}</div>}
    {settings&&<Modal title="保存とアカウント" onClose={()=>{if(!busy&&!cloud.authBusy)setSettings(false);}}>
      <h3>クラウド同期</h3>
      {!cloud.configured?<p className="muted">接続設定はまだありません。このブラウザへの保存を利用できます。</p>:!cloud.authReady?<p className="muted">ログイン状態を確認しています…</p>:cloud.user?<>
        <p className="account-email">{cloud.user.email??"ログイン済みアカウント"}</p><p className="muted">{cloud.identity.mode==="account"?"記録と画像の原本を、このアカウントへ同期します。":"いまは端末内の収集を開いています。アカウントへの送信はしません。"}</p>
        <div className="modal-buttons">{cloud.identity.mode==="account"?<><button className="button" disabled={busy||cloud.authBusy} onClick={()=>void cloud.runSync()}>今すぐ同期</button><button className="button" disabled={busy||cloud.authBusy||dirty} onClick={()=>void cloud.useDevice()}>端末内の収集を開く</button></>:<button className="button" disabled={busy||cloud.authBusy||dirty} onClick={()=>void cloud.useAccount()}>アカウントの収集を開く</button>}<button className="button" disabled={busy||cloud.authBusy} onClick={()=>void cloud.signOut()}>このブラウザからログアウト</button></div>
        {dirty&&<p className="small-note">保存先を切り替える前に、入力中の収集を保存してください。</p>}
        {cloud.identity.mode==="account"&&<><div className="sync-summary"><span>記録の同期待ち {cloud.syncStatus.pending}件</span><span>確認が必要 {cloud.conflicts.length}件</span></div><p className="small-note">記録と原本の画像は別々に送信します。ほかの端末の画像は、カードを開くと読み込みます。</p>{(failedFiles>0||pendingFiles>0)&&<button className="button" disabled={busy} onClick={retryImages}>原本の送信を再試行</button>}{cloud.localCount>0&&<><h4>端末内の収集を取り込む</h4><p className="small-note">元の端末にある{cloud.localCount}件を、このアカウントへ原本と一緒にコピーします。元の収集は残ります。繰り返すと再び追加されます。</p><button className="button" disabled={busy||cloud.authBusy} onClick={()=>void importLocal()}>{cloud.localCount}件を取り込む</button></>}
          {cloud.conflicts.length>0&&<><h4>同じ記録に別の変更があります</h4><p className="small-note">両方を残すと、この端末の版を別の記録として追加します。</p>{cloud.conflicts.map(conflict=><div className="conflict-card" key={conflict.id}><div className="conflict-versions"><div><h4>この端末の版</h4><Version record={conflict.local}/></div><div><h4>クラウドの版</h4><Version record={conflict.remote}/></div></div><div className="modal-buttons"><button className="button primary" disabled={busy} onClick={()=>void perform(async guard=>{await cloud.resolveConflict(conflict.id,"keep_both");if(guard.current())setNotice("両方の版を残しました");})}>両方残す</button><button className="button" disabled={busy} onClick={()=>void perform(async guard=>{await cloud.resolveConflict(conflict.id,"keep_remote");if(guard.current())setNotice("クラウドの版を使います");})}>クラウドの版を使う</button></div></div>)}</>}
        </>}
      </>:<form onSubmit={event=>{event.preventDefault();void cloud.signIn(email);}}><p className="muted">Recallと同じメールログインです。リンクをこのブラウザで開くとRecallに戻ります。そこからCollectを開いてください。</p><label className="field-label" htmlFor="collect-email">メールアドレス</label><input id="collect-email" type="email" autoComplete="email" className="text-input" required value={email} onChange={event=>setEmail(event.target.value)} disabled={cloud.authBusy}/><div className="modal-buttons"><button className="button primary" disabled={cloud.authBusy||!email.trim()}>{cloud.authBusy?"送信中…":"ログインメールを送る"}</button></div></form>}
      {cloud.authMessage&&<p className="auth-message" role="status">{cloud.authMessage}</p>}
      <hr/><h3>スペース</h3><form onSubmit={event=>{event.preventDefault();void perform(async guard=>{if(!guard.repo)return;await guard.repo.createSpace(spaceName);if(guard.current()){setSpaceName("");setNotice("スペースを追加しました");}});}}><input className="text-input" aria-label="新しいスペース名" placeholder="例：参考資料" value={spaceName} maxLength={40} onChange={event=>setSpaceName(event.target.value)} disabled={busy}/><div className="modal-buttons"><button className="button" disabled={busy||!spaceName.trim()}>追加</button></div></form>
      <hr/><h3>バックアップ</h3><p className="muted">この保存先の収集とスペース、画像の原本をJSONに含めます。下書きは含みません。元画像がない場合は取得してから書き出します。</p><div className="modal-buttons"><button className="button" disabled={!ready||busy} onClick={()=>void backup()}><Icon name="download" size={14}/>暗号化バックアップを書き出す</button><button className="button" disabled={!ready||busy} onClick={()=>backupInput.current?.click()}><Icon name="upload" size={14}/>JSONを追加読み込み</button></div><p className="small-note">1回に含められる画像の合計は32MBです。大きい場合はカードの書き出しボタンで分けてください。読み込みは別のIDで追加するため、繰り返すと重複します。</p>
      <hr/><h3>端末への保存</h3><p className="muted">{pwaState}</p><p className="small-note">ブラウザのデータを消すと、未同期の記録や画像も消えます。大切なものはバックアップを残してください。</p><button className="button" onClick={()=>void perform(async guard=>{const kept=await navigator.storage?.persist();if(guard.current())setNotice(kept?"保存領域の保持が許可されました。バックアップも続けてください":"保持を依頼しました。バックアップも続けてください");})}>保存領域の保護を依頼する</button>
    </Modal>}
    {pendingNavigation&&<Modal title="入力中の収集があります" onClose={()=>setPendingNavigation(null)}><p className="muted">いまの内容を保存してから移動できます。閉じると、入力を続けられます。</p><div className="modal-buttons"><button className="button primary" disabled={locked} onClick={async()=>{const work=pendingNavigation;if(await save()){setPendingNavigation(null);work();}}}>保存して移動</button><button className="button" disabled={locked} onClick={()=>{const work=pendingNavigation;setPendingNavigation(null);work();}}>入力を破棄して移動</button><button className="button" onClick={()=>setPendingNavigation(null)}>入力に戻る</button></div></Modal>}
    <input ref={fileInput} type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp" onChange={event=>void chooseFile(event.target.files?.[0])}/>
    <input ref={backupInput} type="file" hidden accept="application/json,.json" onChange={event=>void importBackup(event.target.files?.[0])}/>
  </div>;
}
