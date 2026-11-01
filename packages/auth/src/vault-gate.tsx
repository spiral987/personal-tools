"use client";
import {createContext,useContext,useEffect,useRef,useState,type ReactNode} from "react";
import {captureLegacyVaultShare,clearVaultMemory,createVault,deviceRevocationToken,deviceTokenIsCurrent,lockVault,migrateVaultDatabases,observeVaultLock,readVaultDescriptor,readVaultPolicy,rememberVault,requestVaultLock,requireVault,resumeVault,saveVaultDescriptor,subscribeVault,unlockVault,validateDescriptor,vaultScope,vaultSession,writeVaultPolicy,VAULT_POLICY_KEY,type VaultDescriptor,type VaultLockPolicy} from "@personal-tools/api-client";
import {cloudVaultDescriptor} from "../../api-client/src/vault-cloud.ts";
import {getBrowserAuthClient} from "./browser.ts";
import {GoogleSignInButton} from "./google-sign-in.tsx";
import {authCallbackErrorMessage,callbackLocation,getPublicSupabaseConfig} from "./index.ts";

const panel:React.CSSProperties={width:"min(100% - 32px, 500px)",margin:"8vh auto",padding:28,border:"1px solid #d4dcd5",borderRadius:20,background:"#fffefb",color:"#263e37",boxShadow:"0 12px 60px #263e3710",fontFamily:"system-ui,sans-serif",lineHeight:1.8};
const field:React.CSSProperties={display:"block",width:"100%",boxSizing:"border-box",padding:12,border:"1px solid #a6b7ae",borderRadius:8,margin:"8px 0 16px",fontSize:16};
type Retention={policy:VaultLockPolicy;expiresAt:number|null;busy:boolean;change:(policy:VaultLockPolicy)=>Promise<void>};
const RetentionContext=createContext<Retention|null>(null);
const policies=<><option value="daily">入力成功から24時間保持</option><option value="short">無操作5分・非表示1分でロック</option></>;
export function VaultRetentionSettings(){
 const context=useContext(RetentionContext);if(!context)return null;
 return <section aria-label="解錠の保持"><h3>解錠の保持</h3><label className="field-label">この端末のブラウザ<select aria-label="解錠の保持期間" value={context.policy} disabled={context.busy} onChange={event=>void context.change(event.target.value as VaultLockPolicy)}>{policies}</select></label><p className="small-note">変更すると下書きを保存して金庫をロックします。パスフレーズは保存しません。</p>{context.expiresAt&&<p className="small-note">次の解錠が必要になる時刻：{new Date(context.expiresAt).toLocaleString("ja-JP")}</p>}</section>;
}
export function VaultGate({children}:{children:ReactNode}){
 const [ready,setReady]=useState(false),[unlocked,setUnlocked]=useState(false),[descriptor,setDescriptor]=useState<VaultDescriptor|null>(null);
 const [secret,setSecret]=useState(""),[confirm,setConfirm]=useState(""),[recovery,setRecovery]=useState(false),[recoveryKey,setRecoveryKey]=useState("");
 const [email,setEmail]=useState(""),[message,setMessage]=useState(""),[busy,setBusy]=useState(false),[saved,setSaved]=useState(false),[fatal,setFatal]=useState(false);
 const [policy,setPolicy]=useState<VaultLockPolicy>("daily"),[expiresAt,setExpiresAt]=useState<number|null>(null);
 const scope=useRef(vaultScope(null,null)),account=useRef<string|null>(null),alive=useRef(false),initialized=useRef(false);
 function fail(error:unknown){setMessage(error instanceof Error?error.message:"金庫を開けませんでした。");}
 useEffect(()=>{
  alive.current=true;captureLegacyVaultShare();setPolicy(readVaultPolicy());
  const url=new URL(window.location.href),authError=url.searchParams.get("auth_error");
  if(authError){setMessage(authCallbackErrorMessage(authError));url.searchParams.delete("auth_error");window.history.replaceState(null,"",url.pathname+url.search+url.hash);}
  const stop=subscribeVault(()=>{if(!vaultSession()&&alive.current){setUnlocked(false);setExpiresAt(null);setSecret("");setConfirm("");}});
  const stopControl=observeVaultLock(value=>{if(alive.current)setBusy(value);});
  const client=getBrowserAuthClient();
  function activeAccount(id:string|null){
   try{
    if(new URL(window.location.href).searchParams.get("auth_success")==="1")localStorage.setItem("personal-tools-recall-signed-out","0");
    if(localStorage.getItem("personal-tools-recall-signed-out")==="1")return null;
   }catch{}
   return id;
  }
  async function bootstrap(){
   setReady(false);setFatal(false);let local=await readVaultDescriptor();setDescriptor(local);
   const session=client?(await client.auth.getSession()).data.session:null;
   const id=activeAccount(session?.user?.id??null);account.current=id;
   scope.current=vaultScope(getPublicSupabaseConfig()?.url??null,id);
   if(client&&id){
    let remote:VaultDescriptor|null=null;
    try{remote=await cloudVaultDescriptor(client,id);}catch(error){if(!local)throw error;}
    if(remote){
     if(local&&local.id!==remote.id){setFatal(true);throw new Error("このブラウザの金庫とアカウントの金庫が異なります。別のブラウザプロファイルで開いてください。保持した解錠は引き継ぎません。");}
     if(!local)await saveVaultDescriptor(remote);local=validateDescriptor(remote);
    }
   }
   if(!alive.current)return;
   setDescriptor(local);
   if(local&&readVaultPolicy()==="daily"){
    const resumed=await resumeVault(local,scope.current);
    if(resumed){await migrateVaultDatabases();if(alive.current){setExpiresAt(resumed.expiresAt??null);setUnlocked(true);}}
   }
  }
  void bootstrap().catch(async error=>{lockVault();if(alive.current)fail(error);}).finally(()=>{if(alive.current){initialized.current=true;setReady(true);}});
  const auth=client?.auth.onAuthStateChange((_event,session)=>{
   const id=activeAccount(session?.user?.id??null);
   if(!initialized.current||id===account.current)return;
   // The SDK releases its auth lock before draft I/O and session revocation.
   setTimeout(()=>{if(!alive.current)return;void (async()=>{
    try{await requestVaultLock({force:true});}catch(error){if(alive.current)fail(error);}
    if(!alive.current)return;
    try{await bootstrap();}catch(error){lockVault();if(alive.current)fail(error);}finally{if(alive.current)setReady(true);}
   })();},0);
  });
  const preference=(event:StorageEvent)=>{if(event.key===VAULT_POLICY_KEY)setPolicy(readVaultPolicy());};
  const restoredPage=(event:PageTransitionEvent)=>{if(event.persisted)void bootstrap().catch(error=>{lockVault();if(alive.current)fail(error);}).finally(()=>{if(alive.current)setReady(true);});};
  window.addEventListener("storage",preference);
  window.addEventListener("pageshow",restoredPage);
  return()=>{alive.current=false;initialized.current=false;stop();stopControl();auth?.data.subscription.unsubscribe();window.removeEventListener("storage",preference);window.removeEventListener("pageshow",restoredPage);clearVaultMemory();};
 },[]);
 useEffect(()=>{
  if(!unlocked)return;
  let last=Date.now(),hiddenAt=document.hidden?Date.now():0,locking=false;
  const lock=async(force=false)=>{if(locking)return;locking=true;try{await requestVaultLock({force});}catch(error){if(alive.current)fail(error);}finally{locking=false;}};
  const check=()=>{const current=vaultSession();if(policy==="daily"){if(current?.expiresAt&&Date.now()>=current.expiresAt)void lock(true);}else if(Date.now()-last>=300000||hiddenAt&&Date.now()-hiddenAt>=60000)void lock();};
  const activity=()=>{check();last=Date.now();},visibility=()=>{if(document.hidden)hiddenAt=Date.now();else{check();hiddenAt=0;}};
  const timer=setInterval(check,1000),manual=()=>void lock(),pagehide=()=>clearVaultMemory();
  for(const name of ["pointerdown","pointermove","keydown","input","scroll","wheel"])window.addEventListener(name,activity,{passive:true});
  document.addEventListener("visibilitychange",visibility);window.addEventListener("pagehide",pagehide);window.addEventListener("personal-tools-lock",manual);
  return()=>{clearInterval(timer);for(const name of ["pointerdown","pointermove","keydown","input","scroll","wheel"])window.removeEventListener(name,activity);document.removeEventListener("visibilitychange",visibility);window.removeEventListener("pagehide",pagehide);window.removeEventListener("personal-tools-lock",manual);};
 },[unlocked,policy]);
 async function finishOpen(token:string|null){
  await migrateVaultDatabases();
  const current=requireVault();if(token&&!deviceTokenIsCurrent(token))throw new Error("金庫の状態が変わりました。もう一度解錠してください。");
  current.scope=scope.current;current.retentionToken=token??undefined;
  if(policy==="daily"){
   if(!token)throw new Error("このブラウザでは24時間の解錠保持を利用できません。短時間ロックを選んでください。");
   const expires=await rememberVault(current,scope.current,token);if(alive.current)setExpiresAt(expires);
  }
  if(alive.current){setUnlocked(true);setMessage("");}
 }
 async function submit(){
  if(fatal)return;setBusy(true);setMessage("");
  try{
   try{writeVaultPolicy(policy);}catch(error){if(policy==="daily")throw error;}const token=deviceRevocationToken(policy==="daily");
   if(descriptor){await unlockVault(descriptor,secret,recovery);setSecret("");await finishOpen(token);}
   else{if(secret!==confirm)throw new Error("確認用のパスフレーズが一致しません。");const created=await createVault(secret);await saveVaultDescriptor(created.descriptor);setDescriptor(created.descriptor);setRecoveryKey(created.recoveryKey);setSecret("");setConfirm("");}
  }catch(error){lockVault();fail(error);}finally{if(alive.current)setBusy(false);}
 }
 async function changePolicy(next:VaultLockPolicy){
  if(next===policy)return;setBusy(true);
  try{await requestVaultLock();writeVaultPolicy(next);setPolicy(next);}catch(error){fail(error);}finally{if(alive.current)setBusy(false);}
 }
 async function signIn(){setBusy(true);setMessage("");try{const client=getBrowserAuthClient();if(!client)throw new Error("クラウド接続が未設定です。");const result=await client.auth.signInWithOtp({email:email.trim(),options:{shouldCreateUser:true,emailRedirectTo:callbackLocation(window.location.origin)}});if(result.error)throw new Error("ログインメールを送れませんでした。");setMessage("ログインメールをこのブラウザで開いてください。アカウントの金庫があれば読み込みます。");}catch(error){fail(error);}finally{if(alive.current)setBusy(false);}}
 if(unlocked)return <RetentionContext.Provider value={{policy,expiresAt,busy,change:changePolicy}}>{message&&<p role="status" style={{margin:0,padding:"12px 20px",background:"#fff1d8",color:"#6a4324"}}>{message}</p>}<div inert={busy||undefined}>{children}</div></RetentionContext.Provider>;
 return <main style={panel}><p style={{letterSpacing:3,fontSize:12}}>PERSONAL TOOLS · PRIVATE VAULT</p><h1 style={{fontSize:27,margin:"12px 0"}}>{recoveryKey?"復旧鍵を別に保管":descriptor?"金庫を解錠":"金庫を使い始める"}</h1>
 {message&&<p role="status" style={{whiteSpace:"pre-wrap",color:"#883e31"}}>{message}</p>}
 {!ready?<p>鍵情報を確認しています…</p>:recoveryKey?<><p>復旧鍵を紙など別の場所へ保管してください。パスフレーズを忘れたときに使います。</p><code style={{display:"block",overflowWrap:"anywhere",padding:16,background:"#edf1ed"}}>{recoveryKey}</code><label style={{display:"block",margin:"20px 0"}}><input type="checkbox" checked={saved} onChange={event=>setSaved(event.target.checked)}/> 復旧鍵を紙などの別の場所に保管しました</label><button disabled={!saved||busy} onClick={async()=>{setBusy(true);try{await finishOpen(deviceRevocationToken(policy==="daily"));setRecoveryKey("");}catch(error){lockVault();setRecoveryKey("");fail(error);}finally{setBusy(false);}}}>暗号化した金庫を開く</button></>:<>
 {!descriptor&&!account.current&&<><p>別の端末ですでに使っている場合は、先に同じアカウントでログインしてください。</p><GoogleSignInButton disabled={busy||fatal} onBusyChange={setBusy}/><details style={{marginTop:16}}><summary>メールでログイン</summary><form onSubmit={event=>{event.preventDefault();void signIn();}}><label>メールアドレス<input style={field} type="email" value={email} onChange={event=>setEmail(event.target.value)} required disabled={busy}/></label><button disabled={busy}>既存の金庫にログイン</button></form></details><hr style={{margin:"24px 0",border:0,borderTop:"1px solid #d4dcd5"}}/><h2 style={{fontSize:18}}>初めて使う場合</h2></>}
 <p>内容はこの端末でだけ復号します。メールでのパスフレーズ再発行はできません。</p>
 <form onSubmit={event=>{event.preventDefault();void submit();}}><label>{recovery?"復旧鍵":"専用パスフレーズ"}<input style={field} type="password" value={secret} onChange={event=>setSecret(event.target.value)} autoComplete={descriptor?"current-password":"new-password"} minLength={!descriptor?16:undefined} maxLength={1024} required disabled={busy||fatal}/></label>{!descriptor&&<label>パスフレーズをもう一度<input style={field} type="password" value={confirm} onChange={event=>setConfirm(event.target.value)} autoComplete="new-password" minLength={16} maxLength={1024} required disabled={busy||fatal}/></label>}
 <label>この端末の解錠<select style={field} aria-label="解錠の保持期間" value={policy} disabled={busy} onChange={event=>setPolicy(event.target.value as VaultLockPolicy)}>{policies}</select></label><p style={{fontSize:12}}>24時間保持では、このブラウザに非抽出の復号鍵を期限付きで保存します。パスフレーズは保存しません。共有端末では短時間ロックを選んでください。</p><button disabled={busy||fatal}>{busy?"鍵を処理しています…":descriptor?"解錠する":"金庫と復旧鍵を作る"}</button></form>
 {descriptor&&<button type="button" disabled={busy||fatal} style={{marginTop:16}} onClick={()=>{setRecovery(!recovery);setSecret("");}}>{recovery?"パスフレーズで開く":"復旧鍵で開く"}</button>}
 <label style={{display:"block",marginTop:24}}>暗号化バックアップから金庫の鍵情報を読み込む<input style={{display:"block",maxWidth:"100%"}} type="file" accept=".json,application/json" disabled={busy||fatal} onChange={async event=>{const file=event.target.files?.[0];event.target.value="";if(!file)return;try{if(file.size>100*1024*1024)throw new Error("100MB以下のバックアップを選んでください。");const value=JSON.parse(await file.text());if(value.format!=="personal-tools.encrypted-backup")throw new Error("暗号化バックアップを選んでください。");const d=validateDescriptor(value.vault);await saveVaultDescriptor(d);setDescriptor(d);setMessage("鍵情報を読み込みました。解錠後、各ツールでバックアップを追加読み込みしてください。");}catch(error){fail(error);}}}/></label>
 </>}
 <p style={{fontSize:12,color:"#617268",marginTop:24}}>手動ロック・ログアウト・アカウント変更で保持した鍵を解除します。外部AIとURL情報の自動取得は停止中です。パスフレーズと復旧鍵の両方を失うと復元できません。</p></main>;
}
