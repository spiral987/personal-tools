"use client";
import {useEffect,useRef,useState} from "react";
import {resourceOriginal,MAX_RESOURCE_ORIGINAL_BYTES,type CollectDraft,type Resource,type ResourceDrive,type ResourceFile} from "@personal-tools/core";
import {createDriveClient,driveUploadMarker,prepareResourceFile,prepareResourceImage,requireVault,type RecallRepository} from "@personal-tools/api-client";
import {clearDriveAuthorization,disconnectDrive,driveAccessToken,getDriveAuthorizationState,loadDriveAuthorization,requestDriveAccess,subscribeDriveAuthorization} from "@personal-tools/auth/drive";
import {displayTitle,prettyBytes} from "./capture";
import {driveDocument,driveOriginalSummary} from "./drive-document";

type Settings={folderId:string;folderName:string;accountId:string;target:"vault"|"drive"};
type Guard={repo:RecallRepository;current:()=>boolean};
type Prepare={drive:ResourceDrive;original:ResourceFile;blob:Blob;newId:string};
const stamp=()=>new Date().toISOString();
const invalid=()=>new Error("保存先が変わったため、Driveの処理を中断しました。");

export function useCollectDrive({scopeKey,ready,getRepo,changed,notice}:{scopeKey:string;ready:boolean;getRepo:()=>RecallRepository|null;changed:()=>Promise<unknown>;notice:(message:string)=>void}){
  const latest=useRef({scopeKey,getRepo,changed,notice});latest.current={scopeKey,getRepo,changed,notice};
  const [auth,setAuth]=useState(getDriveAuthorizationState),[settings,setSettings]=useState<Settings|null>(null),[folders,setFolders]=useState<{id:string;name:string}[]>([]),[account,setAccount]=useState<{permissionId:string;emailAddress:string}|null>(null),[message,setMessage]=useState(""),[working,setWorking]=useState(false),[progress,setProgress]=useState<Record<string,string>>({});
  const settingsRef=useRef(settings);settingsRef.current=settings;
  const running=useRef(new Set<string>());
  const previousScope=useRef(scopeKey);
  useEffect(()=>subscribeDriveAuthorization(()=>{setAuth(getDriveAuthorizationState());}),[]);
  useEffect(()=>{
    if(previousScope.current!==scopeKey){clearDriveAuthorization();previousScope.current=scopeKey;setAccount(null);setFolders([]);setProgress({});setMessage("");running.current.clear();}
    let current=true;setSettings(null);
    const repo=getRepo();if(ready&&repo)void repo.loadCollectDriveSettings().then(value=>{if(current&&repo===latest.current.getRepo())setSettings(value);}).catch(()=>{if(current)setMessage("Driveの保存先設定を読み込めませんでした。");});
    return()=>{current=false;};
  },[scopeKey,ready]);
  function guard():Guard{
    const repo=latest.current.getRepo(),vault=requireVault(),scope=latest.current.scopeKey;
    if(!repo)throw new Error("保存先を読み込んでいます。");
    return {repo,current:()=>{try{return repo===latest.current.getRepo()&&scope===latest.current.scopeKey&&requireVault()===vault;}catch{return false;}}};
  }
  function client(g:Guard){return createDriveClient({getAccessToken:()=>{if(!g.current())throw invalid();return driveAccessToken(latest.current.scopeKey);},isCurrent:g.current,onUnauthorized:()=>clearDriveAuthorization()});}
  async function binding(g:Guard,expected?:string){
    const api=client(g),who=await api.account();if(!g.current())throw invalid();
    if(expected&&who.permissionId!==expected)throw new Error("この原本を保存したGoogleアカウントに接続してください。");
    setAccount(who);return {api,who};
  }
  async function folderMarker(){return driveUploadMarker(latest.current.scopeKey,requireVault().descriptor.id,"folders");}
  async function loadFolders(){
    const g=guard(),{api}=await binding(g),marker=await folderMarker();if(!g.current())throw invalid();
    const values=await api.listFolders(marker);if(!g.current())throw invalid();setFolders(values.map(file=>({id:file.id,name:file.name})));
  }
  async function action(work:()=>Promise<void>){if(working)return;setWorking(true);setMessage("");try{await work();}catch(error){setMessage(error instanceof Error?error.message:"Driveの処理を完了できませんでした。");}finally{setWorking(false);}}
  function preload(){if(!getDriveAuthorizationState().configured)return;void loadDriveAuthorization().catch(error=>setMessage(error instanceof Error?error.message:"Googleの接続画面を準備できませんでした。"));}
  function connect(){
    // GIS must open its popup synchronously from this click after script preload.
    const request=requestDriveAccess(scopeKey);
    void action(async()=>{await request;await loadFolders();});
  }
  async function chooseFolder(folderId:string){await action(async()=>{
    const g=guard(),{who}=await binding(g),folder=folders.find(value=>value.id===folderId);if(!folder)return;
    const value:Settings={folderId,folderName:folder.name,accountId:who.permissionId,target:settingsRef.current?.target??"vault"};
    await g.repo.saveCollectDriveSettings(value);if(g.current())setSettings(value);
  });}
  async function createFolder(){await action(async()=>{
    const g=guard(),{api,who}=await binding(g),marker=await folderMarker();if(!g.current())throw invalid();
    const previous=settingsRef.current,folderId=previous?.accountId===who.permissionId&&!folders.some(folder=>folder.id===previous.folderId)?previous.folderId:await api.reserveFileId();
    if(!g.current())throw invalid();const value:Settings={folderId,folderName:"Collect",accountId:who.permissionId,target:previous?.target??"vault"};
    // Persist before creation so retry cannot create duplicate folders.
    await g.repo.saveCollectDriveSettings(value);if(!g.current())throw invalid();setSettings(value);
    await api.createFolder({fileId:folderId,name:value.folderName,scopeMarker:marker});if(!g.current())throw invalid();await loadFolders();
    latest.current.notice("Driveの保存先を用意しました");
  });}
  async function setTarget(target:"vault"|"drive"){
    const g=guard(),previous=settingsRef.current;
    if(target==="drive"&&!previous?.folderId){setMessage("先にDriveへ接続して保存先フォルダーを用意してください。");return;}
    if(!previous)return;const value={...previous,target};await g.repo.saveCollectDriveSettings(value);if(g.current())setSettings(value);
  }
  async function prepare(draft:CollectDraft|Resource,blob:Blob|null,newId=crypto.randomUUID()):Promise<Prepare>{
    const g=guard(),destination=settingsRef.current;if(!destination?.folderId)throw new Error("Driveの保存先フォルダーを設定してください。");
    const {api,who}=await binding(g,destination.accountId),source=blob??driveDocument(draft);
    if(!blob&&!["link","text"].includes(draft.resourceType))throw new Error("原本が端末にありません。取得してからDriveに保存してください。");
    const filename=driveOriginalSummary(draft).name,original=await prepareResourceFile(source,filename);
    const fileId=await api.reserveFileId(),marker=await driveUploadMarker(latest.current.scopeKey,requireVault().descriptor.id,newId);if(!g.current())throw invalid();
    return {newId,blob:source,original,drive:{fileId,folderId:destination.folderId,name:filename,mimeType:original.mimeType,size:original.size,version:"",modifiedTime:null,status:"pending",checkedAt:stamp(),accountId:who.permissionId,marker}};
  }
  async function transfer(resource:Resource,source?:Blob|null){
    if(running.current.has(resource.id))throw new Error("この原本は送信中です。");running.current.add(resource.id);
    const g=guard();try{
      let current=(await g.repo.snapshot()).resources.find(value=>value.id===resource.id);if(!current||current.deletedAt)throw new Error("保存済みの収集を選んでください。");
      let blob=source??await g.repo.getResourceFile(current.id);
      if(!current.drive){
        if(current.localRevision!==resource.localRevision)throw new Error("収集が更新されました。最新の内容を開いて、もう一度確認してください。");
        const prepared=await prepare(current,blob,current.id);blob=prepared.blob;
        current=await g.repo.saveResource({...current,id:current.id,...(current.resourceType!=="image"?{original:prepared.original}:{}),drive:prepared.drive,file:blob,url:current.url??"",sourceUrl:current.sourceUrl??""},current.localRevision);
      }
      if(!g.current())throw invalid();const ref=current.drive!;
      if(ref.status!=="pending")throw new Error("この原本はDriveに保存済みです。更新の確認を使ってください。");
      if(!blob)throw new Error("未送信の原本がこの端末にありません。元の端末で再送してください。");
      const {api}=await binding(g,ref.accountId);if(!ref.marker||!ref.folderId)throw new Error("保存先情報が不足しています。");
      setProgress(value=>({...value,[resource.id]:"送信中…"}));
      const uploaded=await api.uploadFile({fileId:ref.fileId,folderId:ref.folderId,name:ref.name,mimeType:ref.mimeType,blob,marker:ref.marker,onProgress:(sent,total)=>{if(g.current())setProgress(value=>({...value,[resource.id]:`${prettyBytes(sent)} / ${prettyBytes(total)}`}));}});
      if(!g.current())throw invalid();const received=await api.downloadFile(uploaded.id,{maxBytes:MAX_RESOURCE_ORIGINAL_BYTES,expectedVersion:uploaded.version});
      const original=await prepareResourceFile(received.blob,uploaded.name),expected=resourceOriginal(current);if(!g.current())throw invalid();
      if(!expected||original.sha256!==expected.sha256||original.size!==expected.size)throw new Error("Driveへ送った原本の照合に失敗しました。端末の原本を残しています。");
      const latestResource=(await g.repo.snapshot()).resources.find(value=>value.id===resource.id);if(!latestResource||latestResource.drive?.fileId!==ref.fileId)throw invalid();
      await g.repo.updateResource(resource.id,{drive:{...ref,name:uploaded.name,mimeType:uploaded.mimeType,size:uploaded.size,version:uploaded.version,modifiedTime:uploaded.modifiedTime,status:"ready",checkedAt:stamp()}},latestResource.localRevision);
      if(!g.current())throw invalid();setProgress(value=>({...value,[resource.id]:"Driveに保存済み"}));await latest.current.changed();
    }catch(error){if(g.current())setProgress(value=>({...value,[resource.id]:"送信待ち · 再試行できます"}));throw error;}finally{running.current.delete(resource.id);}
  }
  async function refresh(resource:Resource):Promise<Blob|null>{
    const g=guard(),ref=resource.drive;if(!ref||ref.status==="pending")return g.repo.getResourceFile(resource.id);
    if(typeof navigator!=="undefined"&&!navigator.onLine)return g.repo.getResourceFile(resource.id);
    const {api}=await binding(g,ref.accountId),file=await api.getFile(ref.fileId);if(!g.current())throw invalid();
    const saved=(await g.repo.snapshot()).resources.find(value=>value.id===resource.id);if(!saved||saved.drive?.fileId!==ref.fileId||saved.deletedAt)throw invalid();
    if(!file||file.trashed){
      await g.repo.updateResource(saved.id,{drive:{...saved.drive,status:file?.trashed?"trashed":"unavailable",checkedAt:stamp()}},saved.localRevision);
      if(g.current())await latest.current.changed();return g.repo.getResourceFile(saved.id);
    }
    let blob=await g.repo.getResourceFile(saved.id);
    const changedVersion=file.version!==saved.drive.version;
    if(changedVersion||!blob){
      const received=await api.downloadFile(file.id,{maxBytes:MAX_RESOURCE_ORIGINAL_BYTES,expectedVersion:file.version});if(!g.current())throw invalid();blob=received.blob;
      const original=await prepareResourceFile(blob,file.name);
      const latestResource=(await g.repo.snapshot()).resources.find(value=>value.id===saved.id);if(!latestResource||latestResource.drive?.fileId!==ref.fileId)throw invalid();
      let textBody:string|null|undefined;
      if(saved.resourceType==="text"){
        textBody=null;
        if(["text/plain","text/markdown"].includes(original.mimeType)&&blob.size<=400000){try{const value=new TextDecoder("utf-8",{fatal:true}).decode(await blob.arrayBuffer());if(value.length<=100000&&value.trim())textBody=value;}catch{}}
      }
      if(!g.current())throw invalid();
      await g.repo.refreshResourceOriginal(saved.id,original,blob,latestResource.localRevision,{...latestResource.drive,name:file.name,mimeType:file.mimeType,size:file.size,version:file.version,modifiedTime:file.modifiedTime,status:"ready",checkedAt:stamp()},textBody);
      if(g.current()&&changedVersion)latest.current.notice("Driveで更新された原本を読み込みました。自分のメモはそのままです");
    }else{
      await g.repo.updateResource(saved.id,{drive:{...saved.drive,name:file.name,mimeType:file.mimeType,size:file.size,version:file.version,modifiedTime:file.modifiedTime,status:"ready",checkedAt:stamp()}},saved.localRevision);
    }
    if(!g.current())throw invalid();await latest.current.changed();return blob;
  }
  const target=settings?.target??"vault";
  return {auth,settings,target,progress,working,prepare,transfer,refresh,preload,setTarget,
    settingsPanel:<section className="drive-settings" aria-label="Google Driveの保存先"><h3>Google Drive</h3>
      <p className="small-note">Collectから追加した原本だけを、Driveでも開ける普通のファイルとして保存します。自分のメモやタグは金庫に残ります。</p>
      {!auth.configured?<p className="muted">Drive接続は未設定です。管理者がGoogleの接続設定を追加すると利用できます。</p>:<>
        <p>{auth.connected&&auth.scopeKey===scopeKey?`接続中${account?.emailAddress?` · ${account.emailAddress}`:""}`:"Driveへ接続してください。接続はこの画面を開いている間だけ保持します。"}</p>
        <div className="modal-buttons"><button className="button" disabled={working||auth.busy||!auth.loaded} onClick={connect}>{auth.connected?"Driveへ再接続":"Google Driveへ接続"}</button><button className="button" disabled={working||!auth.connected} onClick={()=>void action(loadFolders)}>フォルダー一覧を更新</button>{auth.connected&&<button className="button" disabled={working} onClick={()=>void action(async()=>{await disconnectDrive();setAccount(null);setFolders([]);})}>接続を解除</button>}</div>
        {auth.connected&&<><label className="field-label" htmlFor="drive-folder">保存先フォルダー</label><select id="drive-folder" className="text-input" value={folders.some(folder=>folder.id===settings?.folderId)?settings!.folderId:""} onChange={event=>void chooseFolder(event.target.value)} disabled={working}><option value="">Collect用フォルダーを選ぶ</option>{folders.map(folder=><option key={folder.id} value={folder.id}>{folder.name}</option>)}</select><div className="modal-buttons"><button className="button" disabled={working} onClick={()=>void createFolder()}>Collect用フォルダーを作成</button></div></>}
        {settings&&<p className="small-note">保存先：{settings.folderName}。Driveへ直接追加した別ファイルは取り込みません。</p>}
      </>}
      {(message||auth.error)&&<p role="status">{message||auth.error}</p>}
    </section>,
  };
}

export function DriveRecordStatus({resource,progress}:{resource:Resource;progress?:string}){
  if(!resource.drive)return null;const ref=resource.drive;
  return <div className="drive-record-status"><strong>{progress??(ref.status==="pending"?"Driveへの送信待ち":ref.status==="trashed"?"Driveのごみ箱にあります":ref.status==="unavailable"?"Driveの原本を取得できません":"Driveに保存")}</strong><span>最終確認：{new Date(ref.checkedAt).toLocaleString("ja-JP")}</span>{ref.status!=="pending"&&<a href={`https://drive.google.com/file/d/${encodeURIComponent(ref.fileId)}/view`} target="_blank" rel="noopener noreferrer">Driveで原本を開く</a>}</div>;
}
