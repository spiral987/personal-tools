"use client";
import {useRef,useState} from "react";
import {Modal} from "./components";
import {prettyBytes} from "./capture";

type Entry={file:File;state:"waiting"|"saving"|"saved"|"error";message:string};
export function BulkImport({files,onSave,onBusy,onClose}:{files:File[];onSave:(file:File)=>Promise<string>;onBusy:(busy:boolean)=>void;onClose:()=>void}){
  const [entries,setEntries]=useState<Entry[]>(()=>files.map(file=>({file,state:"waiting",message:""}))),[running,setRunning]=useState(false);
  const runningRef=useRef(false);
  async function run(){
    if(runningRef.current)return;runningRef.current=true;setRunning(true);onBusy(true);
    try{
      for(let i=0;i<entries.length;i++){
        if(entries[i].state==="saved")continue;
        setEntries(value=>value.map((entry,index)=>index===i?{...entry,state:"saving",message:"原本を確認・保存中…"}:entry));
        try{const message=await onSave(entries[i].file);setEntries(value=>value.map((entry,index)=>index===i?{...entry,state:"saved",message}:entry));}
        catch(error){setEntries(value=>value.map((entry,index)=>index===i?{...entry,state:"error",message:error instanceof Error?error.message:"保存できませんでした"}:entry));}
      }
    }finally{runningRef.current=false;setRunning(false);onBusy(false);}
  }
  const saved=entries.filter(entry=>entry.state==="saved").length,failed=entries.filter(entry=>entry.state==="error").length;
  return <Modal title="ファイルをまとめて追加" onClose={()=>{if(!running)onClose();}}>
    <p>{files.length}件 · 合計{prettyBytes(files.reduce((total,file)=>total+file.size,0))}</p>
    <p className="small-note">各ファイルを別の収集として保存します。同じ原本の候補は結果に表示します。保存できた分は残り、失敗した分だけ再試行できます。</p>
    <ol className="bulk-files" aria-label="ファイルごとの保存結果">{entries.map((entry,index)=><li key={index}><strong>{entry.file.name}</strong><span>{prettyBytes(entry.file.size)} · {entry.state==="waiting"?"追加待ち":entry.message}</span></li>)}</ol>
    <p role="status">{saved}/{entries.length}件保存済み{failed?` · ${failed}件を確認してください`:""}</p>
    <div className="modal-buttons"><button className="button primary" disabled={running||saved===entries.length} onClick={()=>void run()}>{running?"追加しています…":failed?"未保存のファイルを再試行":"この内容で追加する"}</button><button className="button" disabled={running} onClick={onClose}>閉じる</button></div>
  </Modal>;
}
