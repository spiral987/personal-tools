"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {accountDatabaseName,authCallbackErrorMessage,callbackLocation,createSharedSessionRefresh,getPublicSupabaseConfig,type Identity,type SharedSessionRefreshBoundary} from "./index.ts";
import {getBrowserAuthClient,type BrowserAuthClient} from "./browser.ts";
import {openRecallRepository,openAccountRecallRepository,createSyncEngine,createEncryptedSyncTransport,type RecallRepository,type AccountRecallRepository,type SuiteSnapshot} from "@personal-tools/api-client";
import {prepareVaultRetention} from "../../api-client/src/vault-retention.ts";
import {prepareCloudVault} from "../../api-client/src/vault-cloud.ts";
import {requestVaultLock,flushVaultDrafts,vaultSession} from "../../api-client/src/vault.ts";
import {vaultScope} from "../../api-client/src/vault-device.ts";
import type {Note,Space,Sketch,ItemRelation,SketchDraft,CollectDraft,Resource,SyncConflict,SyncStatus} from "@personal-tools/core";

export type CloudApp="recall"|"sketchbook"|"collect"|"atlas";
export type CloudSnapshot=SuiteSnapshot;
type DraftFor<A extends CloudApp>=A extends "collect"?CollectDraft:A extends "sketchbook"?SketchDraft:{body:string;spaceIds:string[]};
type ImportFor<A extends CloudApp>=A extends "collect"?{resources:number;spaces:number}:A extends "sketchbook"?{sketches:number;spaces:number}:{notes:number;spaces:number};
export type CloudCallbacks<A extends CloudApp>={reset:()=>void;ready:(repository:RecallRepository,data:CloudSnapshot,draft:DraftFor<A>)=>void;snapshot:(data:CloudSnapshot)=>void;failure:(error:unknown)=>void};
type User={id:string;email?:string};
type CachedSession=Awaited<ReturnType<BrowserAuthClient["auth"]["getSession"]>>["data"]["session"];
const EMPTY_STATUS:SyncStatus={phase:"idle",pending:0,conflicts:0,lastSyncedAt:null};
const MODE_KEY="personal-tools-recall-mode",LOCK_KEY="personal-tools-recall-signed-out";
function readPreference(key:string){try{return (key===LOCK_KEY?localStorage:sessionStorage).getItem(key);}catch{return null;}}
function writePreference(key:string,value:string){try{(key===LOCK_KEY?localStorage:sessionStorage).setItem(key,value);}catch{}}
const accountRepository=(repo:RecallRepository|null):AccountRecallRepository|null=>repo&&"ownerId" in repo?repo as AccountRecallRepository:null;

export function usePersonalToolsCloud<A extends CloudApp>(callbacks:CloudCallbacks<A>,options:{app:A}) {
  const app=options.app;
  const callbacksRef=useRef(callbacks);callbacksRef.current=callbacks;
  const current=useRef<RecallRepository|null>(null),client=useRef<BrowserAuthClient|null>(null);
  const authRefresh=useRef<SharedSessionRefreshBoundary|null>(null);
  const engine=useRef<ReturnType<typeof createSyncEngine>|null>(null);
  const cleanups=useRef<(()=>void)[]>([]),generation=useRef(0),mounted=useRef(false),target=useRef("");
  const currentUser=useRef<User|null>(null),locked=useRef(false),nextAutoAttempt=useRef(0),failureCount=useRef(0);
  const [identity,setIdentity]=useState<Identity>({mode:"device"});
  const [user,setUser]=useState<User|null>(null),[configured,setConfigured]=useState(false),[authReady,setAuthReady]=useState(false);
  const [syncStatus,setSyncStatus]=useState<SyncStatus>(EMPTY_STATUS),[conflicts,setConflicts]=useState<SyncConflict[]>([]);
  const [pendingItemIds,setPendingItemIds]=useState<string[]>([]),[localCount,setLocalCount]=useState(0),[authMessage,setAuthMessage]=useState("");
  const [authBusy,setAuthBusy]=useState(false);

  const closeCurrent=useCallback(()=>{
    generation.current++;target.current="";
    authRefresh.current?.cancel();
    for(const cleanup of cleanups.current)cleanup();cleanups.current=[];
    engine.current?.stop();engine.current=null;
    current.current?.close();current.current=null;
    nextAutoAttempt.current=0;failureCount.current=0;
    if(mounted.current){setSyncStatus(EMPTY_STATUS);setConflicts([]);setPendingItemIds([]);setLocalCount(0);callbacksRef.current.reset();}
  },[]);
  const refresh=useCallback(async()=>{
    const repository=current.current,epoch=generation.current;if(!repository)return;
    try{
      const data=await repository.snapshot();
      const account=accountRepository(repository),state=account?await account.getSyncState():null;
      if(!mounted.current||epoch!==generation.current||repository!==current.current)return;
      callbacksRef.current.snapshot(data);
      if(state){setConflicts(state.conflicts);setPendingItemIds(state.pendingItemIds);}
    }catch(error){if(mounted.current&&epoch===generation.current)callbacksRef.current.failure(error);}
  },[]);
  const runSync=useCallback(async(manual=true)=>{
    const currentEngine=engine.current,epoch=generation.current;if(!currentEngine)return;
    if(!manual&&Date.now()<nextAutoAttempt.current)return;
    try{
      const status=await currentEngine.run();
      if(!mounted.current||epoch!==generation.current)return;
      if(status.phase==="error"){failureCount.current++;nextAutoAttempt.current=Date.now()+Math.min(300000,5000*2**Math.min(failureCount.current,6));}
      else{failureCount.current=0;nextAutoAttempt.current=0;}
      await refresh();
    }catch{if(mounted.current&&epoch===generation.current)setAuthMessage("同期できませんでした。端末への保存は続けられます。あとで「今すぐ同期」をお試しください。");}
  },[refresh]);

  const selectWorkspace=useCallback(async(next:Identity)=>{
    const key=next.mode==="account"?`account:${next.userId}`:"device";
    if(target.current===key)return;
    closeCurrent();const epoch=generation.current;target.current=key;
    setIdentity(next);
    try{
      const project=getPublicSupabaseConfig();
      const repository=next.mode==="account"&&project?await openAccountRecallRepository(next.userId,{name:accountDatabaseName(next.userId,project.url)}):await openRecallRepository();
      if(!mounted.current||epoch!==generation.current){repository.close();return;}
      if(next.mode==="account"&&client.current){try{await prepareCloudVault(client.current,repository as AccountRecallRepository,()=>mounted.current&&epoch===generation.current);await prepareVaultRetention(client.current,next.userId,()=>mounted.current&&epoch===generation.current);}catch(error){repository.close();throw error;}if(!mounted.current||epoch!==generation.current){repository.close();return;}}
      const [data,draft]=await Promise.all([repository.snapshot(),(app==="collect"?repository.loadCollectDraft():app==="sketchbook"?repository.loadSketchDraft():repository.loadDraft())]);
      if(!mounted.current||epoch!==generation.current){repository.close();return;}
      current.current=repository;callbacksRef.current.ready(repository,data,draft as DraftFor<A>);
      const account=accountRepository(repository);
      if(account&&client.current){
        const authClient=client.current;
        const transport=createEncryptedSyncTransport({rpc:async(name,args)=>await authClient.rpc(name,args)},account.ownerId);
        const sync=createSyncEngine(account,transport);engine.current=sync;
        cleanups.current.push(sync.subscribe(status=>{if(mounted.current&&epoch===generation.current)setSyncStatus(status);}));
        setSyncStatus(sync.getStatus());
        const local=await openRecallRepository();
        try{const snapshot=await local.snapshot();if(mounted.current&&epoch===generation.current)setLocalCount(app==="collect"?snapshot.resources.length:app==="sketchbook"?snapshot.sketches.length:snapshot.notes.length);}finally{local.close();}
        if(!mounted.current||epoch!==generation.current)return;
        void runSync(false);
      }
      cleanups.current.push(repository.subscribe(()=>{
        if(!mounted.current||epoch!==generation.current)return;
        void refresh().then(async()=>{
          if(!mounted.current||epoch!==generation.current)return;
          const account=accountRepository(repository);if(!account)return;
          const state=await account.getSyncState();
          if(state.pending&&mounted.current&&epoch===generation.current)void runSync(false);
        }).catch(error=>{if(mounted.current&&epoch===generation.current)callbacksRef.current.failure(error);});
      }));
      const sweep=setInterval(()=>{if(mounted.current&&epoch===generation.current)void repository.purgeExpired().catch(error=>callbacksRef.current.failure(error));},30000);cleanups.current.push(()=>clearInterval(sweep));
      await refresh();
    }catch(error){if(mounted.current&&epoch===generation.current){target.current="";callbacksRef.current.failure(error);}}
  },[app,closeCurrent,refresh,runSync]);

  useEffect(()=>{
    mounted.current=true;const config=getPublicSupabaseConfig();setConfigured(!!config);
    locked.current=readPreference(LOCK_KEY)==="1";
    const url=new URL(window.location.href);
    const callbackSucceeded=url.searchParams.get("auth_success")==="1";
    if(callbackSucceeded){
      locked.current=false;writePreference(LOCK_KEY,"0");writePreference(MODE_KEY,"account");
      url.searchParams.delete("auth_success");window.history.replaceState(null,"",url.pathname+url.search+url.hash);
    }
    const failure=url.searchParams.get("auth_error");
    if(failure){
      setAuthMessage(authCallbackErrorMessage(failure));
      url.searchParams.delete("auth_error");window.history.replaceState(null,"",url.pathname+url.search+url.hash);
    }
    const auth=config?getBrowserAuthClient():null;client.current=auth;
    let authUnsubscribe:()=>void=()=>{};
    let refreshSharedSession:()=>void=()=>{};
    if(!auth){setAuthReady(true);void selectWorkspace({mode:"device"});}
    else{
      // This client session selects a local namespace only. Postgres validates every RPC's JWT.
      // The callback is intentionally synchronous: run SDK work after Supabase releases its auth lock.
      const applyAuthSession=(session:CachedSession,event?:string)=>{
        if(!mounted.current)return;
        const wasLocked=locked.current;
        locked.current=boundary.isBlocked();
        if(wasLocked&&!locked.current&&event==="SIGNED_IN")writePreference(MODE_KEY,"account");
        const incoming=!locked.current&&session?.user?{id:session.user.id,email:session.user.email}:null;
        const active=vaultSession();
        if(active?.scope&&active.scope!==vaultScope(config?.url??null,incoming?.id??null)){
          setTimeout(()=>{void requestVaultLock({force:true}).catch(error=>{if(mounted.current)callbacksRef.current.failure(error);});},0);
          return;
        }
        const changed=currentUser.current?.id!==incoming?.id;
        if(changed||event==="SIGNED_OUT")closeCurrent();
        currentUser.current=incoming;setUser(incoming);setAuthReady(true);
        const intended=incoming&&readPreference(MODE_KEY)!=="device"?{mode:"account" as const,userId:incoming.id}:{mode:"device" as const};
        const authEpoch=generation.current;
        setTimeout(()=>{if(mounted.current&&authEpoch===generation.current)void selectWorkspace(intended);},0);
      };
      const boundary=createSharedSessionRefresh<CachedSession>({
        readLock:()=>readPreference(LOCK_KEY),
        // A browser getSession reads the updated cookie storage, not server authorization.
        readSession:async()=>{const {data,error}=await auth.auth.getSession();if(error)throw error;return data.session;},
        applySession:session=>applyAuthSession(session,"SIGNED_IN"),
        schedule:work=>{setTimeout(work,0);},
      });
      authRefresh.current=boundary;
      refreshSharedSession=()=>{
        locked.current=boundary.isBlocked();
        if(locked.current)return;
        writePreference(MODE_KEY,"account");
        boundary.request();
      };
      const {data}=auth.auth.onAuthStateChange((event,session)=>applyAuthSession(session,event));
      authUnsubscribe=()=>data.subscription.unsubscribe();
    }
    const online=()=>void runSync(false),focus=()=>{void refresh();if(document.visibilityState==="visible")void runSync(false);};
    const visible=()=>{if(document.visibilityState==="visible")focus();};
    window.addEventListener("online",online);window.addEventListener("focus",focus);document.addEventListener("visibilitychange",visible);
    const timer=setInterval(()=>{if(document.visibilityState==="visible"&&navigator.onLine)void runSync(false);},30000);
    const logoutChannel=typeof BroadcastChannel!=="undefined"?new BroadcastChannel("personal-tools-auth-control"):null;
    const closeAccountDisplay=()=>{
      authRefresh.current?.block();
      locked.current=true;writePreference(LOCK_KEY,"1");writePreference(MODE_KEY,"device");
      void requestVaultLock({force:true}).catch(error=>{if(mounted.current)callbacksRef.current.failure(error);});
    };
    if(logoutChannel)logoutChannel.onmessage=event=>{
      if(event.data==="logout")closeAccountDisplay();
      else if(event.data==="login")refreshSharedSession();
    };
    const sharedLockChanged=(event:StorageEvent)=>{
      if(event.key!==LOCK_KEY)return;
      if(event.newValue==="1")closeAccountDisplay();
      else if(event.newValue==="0")refreshSharedSession();
    };
    window.addEventListener("storage",sharedLockChanged);
    if(callbackSucceeded)logoutChannel?.postMessage("login");
    return()=>{mounted.current=false;authUnsubscribe();authRefresh.current?.stop();authRefresh.current=null;clearInterval(timer);logoutChannel?.close();window.removeEventListener("storage",sharedLockChanged);window.removeEventListener("online",online);window.removeEventListener("focus",focus);document.removeEventListener("visibilitychange",visible);closeCurrent();};
  },[closeCurrent,selectWorkspace,refresh,runSync]);

  async function signIn(email:string){
    if(!client.current){setAuthMessage("先にクラウド接続の設定を行ってください。");return;}
    setAuthBusy(true);setAuthMessage("");
    try{
      const {error}=await client.current.auth.signInWithOtp({email:email.trim(),options:{shouldCreateUser:true,emailRedirectTo:callbackLocation(window.location.origin)}});
      setAuthMessage(error?"メールを送れませんでした。送信上限とメール認証の設定を確認し、少し待って再度お試しください。":"ログイン用のメールを送りました。このブラウザでメールのリンクを開いてください。");
    }catch{setAuthMessage("メールを送れませんでした。通信状態を確認して、もう一度お試しください。");}
    finally{if(mounted.current)setAuthBusy(false);}
  }
  async function signOut(){
    const auth=client.current;if(!auth)return;
    setAuthBusy(true);setAuthMessage("");
    try{await requestVaultLock();}catch(error){if(mounted.current){setAuthBusy(false);setAuthMessage(error instanceof Error?error.message:"下書きを保存できませんでした。");}return;}
    authRefresh.current?.block();
    locked.current=true;writePreference(LOCK_KEY,"1");writePreference(MODE_KEY,"device");
    currentUser.current=null;
    if(typeof BroadcastChannel!=="undefined"){const channel=new BroadcastChannel("personal-tools-auth-control");channel.postMessage("logout");channel.close();}
    try{
      // Local scope ends this browser's session, leaving the user's other devices signed in.
      const {error}=await auth.auth.signOut({scope:"local"});
      if(error){auth.auth.stopAutoRefresh();setAuthMessage("この端末の表示を閉じました。通信できずサーバー側のログアウトを完了できていません。再ログインするまでアカウントのメモは開きません。");}
      else setAuthMessage("このブラウザからログアウトしました。端末内モードを利用できます。");
    }catch{auth.auth.stopAutoRefresh();setAuthMessage("この端末の表示を閉じました。サーバー側のログアウトは通信復帰後に確認してください。");}
    finally{if(mounted.current)setAuthBusy(false);}
  }
  async function useDevice(){await flushVaultDrafts();writePreference(MODE_KEY,"device");await selectWorkspace({mode:"device"});}
  async function useAccount(){const user=currentUser.current;if(!user)return;await flushVaultDrafts();writePreference(MODE_KEY,"account");await selectWorkspace({mode:"account",userId:user.id});}
  async function importDevice(){
    const repository=accountRepository(current.current),epoch=generation.current;if(!repository)return null;
    let result:ImportFor<A>;
    if(app==="collect"){
      const local=await openRecallRepository();
      try{const backup=await local.exportCollectBackup();if(epoch!==generation.current)return null;result=await repository.importCollectBackup(backup) as ImportFor<A>;}finally{local.close();}
    }else if(app==="sketchbook"){
      const local=await openRecallRepository();
      try{result=await repository.importSketchBackup(await local.exportSketchBackup()) as ImportFor<A>;}finally{local.close();}
    }else result=await repository.importDeviceData() as ImportFor<A>;
    if(epoch!==generation.current)return null;
    await refresh();void runSync(false);return result;
  }
  async function resolveConflict(id:string,resolution:"keep_remote"|"keep_both"){
    const repository=accountRepository(current.current),epoch=generation.current;if(!repository)return;
    await repository.resolveConflict(id,resolution);if(epoch!==generation.current)return;
    await refresh();void runSync(false);
  }
  return {identity,user,configured,authReady,authBusy,authMessage,syncStatus,conflicts,pendingItemIds,localCount,
    signIn,signOut,useDevice,useAccount,switchWorkspace:(mode:"device"|"account")=>mode==="device"?useDevice():useAccount(),runSync,importDevice,resolveConflict,refresh};
}
