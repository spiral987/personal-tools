"use client";
import {useEffect,useRef,useState} from "react";
import {Button} from "@personal-tools/ui";
import type {SyncRecord} from "@personal-tools/core";
import type {useRecallCloud} from "./use-recall-cloud";
type Cloud=ReturnType<typeof useRecallCloud>;
const versionText=(record:SyncRecord)=>{
  if("kind" in record&&record.kind==="resource")return `${record.deletedAt?"［ごみ箱の版］\n":""}${record.title||record.url||"収集した画像"}\n${record.memo}`;
  if("body" in record)return `${record.deletedAt?"［ごみ箱の版］\n":""}${record.body}`;
  if("kind" in record&&record.kind==="sketch")return `${record.deletedAt?"［ごみ箱の版］\n":""}${record.title||"無題のスケッチ"}\n${record.strokes.length}ストローク`;
  if("kind" in record&&record.kind==="relation")return `着想元とのつながり${record.deletedAt?"（解除）":""}`;
  return "name" in record?record.name:"";
};
export function CloudSettings({cloud,onNotice,onError}:{cloud:Cloud;onNotice:(message:string)=>void;onError:(error:unknown)=>void}){
  const [email,setEmail]=useState(""),[busy,setBusy]=useState(false);const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  async function perform(work:()=>Promise<void>){setBusy(true);try{await work();}catch(error){if(alive.current)onError(error);}finally{if(alive.current)setBusy(false);}}
  return <section className="cloud-settings" aria-labelledby="cloud-title"><h3 id="cloud-title">クラウド同期</h3>
    {!cloud.configured?<div className="cloud-setup"><p className="muted">Supabaseの接続設定はまだありません。いまは端末内モードで利用できます。</p><p className="small-note">設定手順はプロジェクトの <strong>docs/phase2-setup.md</strong> にあります。接続情報を設定してサーバーを再起動すると、ここからログインできます。</p></div>:
      !cloud.authReady?<p className="muted">ログイン状態を確認しています…</p>:cloud.user?<>
        <p className="account-email">{cloud.user.email??"ログイン済みアカウント"}</p>
        <p className="muted">{cloud.identity.mode==="account"?"このアカウントのメモを開いています。端末への保存後、通信できるときにクラウドへ送ります。":"いまは端末内のノートを開いています。アカウントのノートとは分けて保存されます。"}</p>
        <div className="cloud-buttons">{cloud.identity.mode==="account"?<><Button disabled={busy||cloud.authBusy||cloud.syncStatus.phase==="syncing"} onClick={()=>void cloud.runSync()}>今すぐ同期</Button><Button disabled={busy||cloud.authBusy} onClick={()=>void cloud.useDevice()}>端末内のノートを開く</Button></>:<Button disabled={busy||cloud.authBusy} onClick={()=>void cloud.useAccount()}>アカウントのノートを開く</Button>}<Button disabled={busy||cloud.authBusy} onClick={()=>void cloud.signOut()}>このブラウザからログアウト</Button></div>
        {cloud.identity.mode==="account"&&<><div className="sync-summary" role="status"><span>同期待ち {cloud.syncStatus.pending}件</span><span>確認が必要 {cloud.conflicts.length}件</span></div>{cloud.syncStatus.phase==="error"&&<p className="sync-warning">同期できませんでした。端末への保存は続けられます。通信と接続設定を確認して、もう一度お試しください。</p>}{cloud.syncStatus.lastSyncedAt&&<p className="small-note">最終同期：{new Intl.DateTimeFormat("ja-JP",{dateStyle:"short",timeStyle:"short"}).format(new Date(cloud.syncStatus.lastSyncedAt))}</p>}
          {cloud.localCount>0&&<div className="local-import"><h4>端末内のメモを取り込む</h4><p className="small-note">元の端末内ノートには{cloud.localCount}件の保存済みメモがあります（ごみ箱を含む）。下のボタンを押すと、いまのアカウントにコピーして同期します。元のノートと下書きは残ります。繰り返すと再び追加されます。</p><Button disabled={busy||cloud.authBusy} onClick={()=>void perform(async()=>{const result=await cloud.importDevice();if(result&&alive.current)onNotice(`${result.notes}件をアカウントにコピーしました`);})}>{cloud.localCount}件をこのアカウントに取り込む</Button></div>}
          {cloud.conflicts.length>0&&<div className="conflict-list"><h4>同じ記録に別の変更があります</h4><p className="small-note">両方の版を確認して残し方を選べます。「両方残す」は端末の版を別の記録として追加します。</p>{cloud.conflicts.map(conflict=><article className="conflict-card" key={conflict.id}><div className="conflict-versions"><div><h5>この端末の版</h5><pre>{versionText(conflict.local)}</pre></div><div><h5>クラウドの版</h5><pre>{versionText(conflict.remote)}</pre></div></div><div className="cloud-buttons"><Button className="primary" disabled={busy} onClick={()=>void perform(async()=>{await cloud.resolveConflict(conflict.id,"keep_both");if(alive.current)onNotice("両方の版を残しました");})}>両方残す</Button><Button disabled={busy} onClick={()=>void perform(async()=>{await cloud.resolveConflict(conflict.id,"keep_remote");if(alive.current)onNotice("クラウドの版を使います");})}>クラウドの版を使う</Button></div></article>)}</div>}
        </>}
      </>:<form className="login-form" onSubmit={event=>{event.preventDefault();void cloud.signIn(email);}}><p className="muted">メールのリンクからログインすると、複数の端末で同じメモを使えます。初回はこのメールアドレスでアカウントを作ります。</p><label className="field-label" htmlFor="login-email">メールアドレス</label><input id="login-email" className="text-input" type="email" autoComplete="email" required value={email} onChange={event=>setEmail(event.target.value)} placeholder="you@example.com" disabled={cloud.authBusy}/><Button className="primary" type="submit" disabled={cloud.authBusy||!email.trim()}>{cloud.authBusy?"送信中…":"ログインメールを送る"}</Button></form>}
    {cloud.authMessage&&<p className="auth-message" role="status">{cloud.authMessage}</p>}
  </section>;
}
