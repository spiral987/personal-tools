"use client";
import {useEffect,useRef,useState} from "react";
import {flushVaultDrafts} from "@personal-tools/api-client";
import {getBrowserAuthClient} from "./browser.ts";
import {googleSignInLocation} from "./google.ts";

export function GoogleSignInButton({disabled=false,onBusyChange}:{disabled?:boolean;onBusyChange?:(busy:boolean)=>void}){
  const alive=useRef(false),running=useRef(false);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState("");
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  async function signIn(){
    if(disabled||running.current)return;
    running.current=true;setBusy(true);onBusyChange?.(true);setMessage("");
    try{
      const client=getBrowserAuthClient();
      if(!client)throw new Error("クラウド接続が未設定です。");
      await flushVaultDrafts();
      const destination=await googleSignInLocation(client.auth,window.location.origin);
      if(alive.current)window.location.assign(destination);
    }catch(error){if(alive.current)setMessage(error instanceof Error?error.message:"Googleログインを開始できませんでした。もう一度お試しください。");}
    finally{running.current=false;if(alive.current){setBusy(false);onBusyChange?.(false);}}
  }
  return <section aria-label="Googleでログイン">
    <p className="muted">Googleアカウントを選んでログインできます。メールを開く操作は不要です。</p>
    <button type="button" className="button" disabled={disabled||busy} onClick={()=>void signIn()} style={{display:"inline-flex",alignItems:"center",justifyContent:"center",gap:12,minHeight:44,padding:"10px 20px",border:"1px solid #747775",borderRadius:8,background:"#fff",color:"#1f1f1f",fontFamily:"system-ui,sans-serif",fontSize:16,cursor:disabled||busy?"default":"pointer"}}>
      <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#4285F4" d="M43.61 24.46c0-1.36-.12-2.66-.35-3.92H24.42v7.42h10.76a9.21 9.21 0 0 1-4 6.05v5.03h6.48c3.8-3.5 5.95-8.65 5.95-14.58Z"/><path fill="#34A853" d="M24.42 44c5.4 0 9.94-1.79 13.25-4.86l-6.48-5.03c-1.8 1.21-4.1 1.94-6.77 1.94-5.2 0-9.61-3.51-11.19-8.24H6.55v5.19A20 20 0 0 0 24.42 44Z"/><path fill="#FBBC05" d="M13.23 27.81a12 12 0 0 1 0-7.62V15H6.55a20 20 0 0 0 0 18l6.68-5.19Z"/><path fill="#EA4335" d="M24.42 11.95c2.94 0 5.55 1.01 7.63 2.98l5.72-5.73A19.2 19.2 0 0 0 24.42 4 20 20 0 0 0 6.55 15l6.68 5.19c1.58-4.73 5.99-8.24 11.19-8.24Z"/></svg>
      {busy?"Googleに移動しています…":"Googleでログイン"}
    </button>
    {message&&<p role="status">{message}</p>}
  </section>;
}
