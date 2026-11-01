"use client";
import {useEffect,useId,useRef,useState,type MouseEvent,type ReactNode} from "react";
import {createDraftNavigation} from "./navigation.ts";

export const SUITE_TOOLS=[
  {id:"atlas",name:"Atlas",description:"横断検索とプロジェクト",href:"/atlas/",symbol:"⌘"},
  {id:"recall",name:"Recall",description:"メモを書く",href:"/recall/",symbol:"R"},
  {id:"collect",name:"Collect",description:"URLと画像を追加",href:"/collect/",symbol:"▧"},
  {id:"sketchbook",name:"Sketchbook",description:"スケッチを描く",href:"/sketchbook/",symbol:"▱"},
] as const;
export type SuiteTool=typeof SUITE_TOOLS[number]["id"];
export type SuiteView={id:string;label:string;count?:number};
export type SuiteSpace={id:string;name:string;color:string;count?:number};
export type SuiteNavigation=ReturnType<typeof useDraftNavigation>;

export function useDraftNavigation(options:{prepare:()=>Promise<boolean>;blocked:boolean;hasDraft?:boolean;failure:(error:unknown)=>void;onLeaving?:()=>void}){
  const latest=useRef(options);latest.current=options;
  const [pending,setPending]=useState(false),leaving=useRef(false);
  const navigate=useRef<ReturnType<typeof createDraftNavigation>|null>(null);
  if(!navigate.current)navigate.current=createDraftNavigation({
    blocked:()=>latest.current.blocked,
    prepare:()=>latest.current.prepare(),
    failure:error=>latest.current.failure(error),pending:setPending,
    commit:href=>{leaving.current=true;latest.current.onLeaving?.();window.location.assign(href);},
  });
  useEffect(()=>{
    const before=(event:BeforeUnloadEvent)=>{if(latest.current.hasDraft&&!leaving.current)event.preventDefault();};
    window.addEventListener("beforeunload",before);return()=>window.removeEventListener("beforeunload",before);
  },[]);
  function follow(event:MouseEvent,href:string){
    if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    const url=new URL(href,window.location.href);
    if(url.origin!==window.location.origin||!/^\/(atlas|recall|collect|sketchbook)(\/|$)/.test(url.pathname))return;
    event.preventDefault();void navigate.current!(url.href);
  }
  function onClick(event:MouseEvent){
    const link=(event.target as Element).closest<HTMLAnchorElement>("a[href]");
    if(link?.getAttribute("href")?.startsWith("#"))return;
    if(link?.getAttribute("aria-current")==="page"){
      if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey)event.preventDefault();
      return;
    }
    if(link&&link.target!=="_blank"&&!link.hasAttribute("download"))follow(event,link.href);
  }
  return {pending,blocked:options.blocked,follow,onClick};
}

function ToolLinks({current,disabled}:{current:SuiteTool;disabled?:boolean}){
  return <>{SUITE_TOOLS.map(tool=><a key={tool.id} href={tool.href} aria-disabled={disabled||undefined} aria-current={current===tool.id?"page":undefined}><span className="pt-tool-symbol" aria-hidden="true">{tool.symbol}</span><span>{tool.name}</span>{current===tool.id&&<small>使用中</small>}</a>)}</>;
}
export function SpaceList({spaces,value,onChange,onAdd,disabled}:{spaces:SuiteSpace[];value:string;onChange:(id:string)=>void;onAdd?:()=>void;disabled?:boolean}){
  return <section className="pt-spaces"><div className="pt-side-heading"><span>スペース</span>{onAdd&&<button type="button" aria-label="スペースを追加" onClick={onAdd} disabled={disabled}>＋</button>}</div><nav aria-label="スペース">{spaces.map(space=><button type="button" key={space.id} className={value===space.id?"is-active":""} aria-pressed={value===space.id} onClick={()=>onChange(value===space.id?"":space.id)} disabled={disabled}><i style={{background:space.color}}/><span>{space.name}</span>{space.count!==undefined&&<small>{space.count}</small>}</button>)}</nav></section>;
}
export function SearchField({label,value,onChange,placeholder}:{label:string;value:string;onChange:(value:string)=>void;placeholder?:string}){
  return <label className="pt-search"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg><input type="search" aria-label={label} value={value} onChange={event=>onChange(event.target.value)} placeholder={placeholder??label}/>{value&&<button type="button" aria-label="検索をクリア" onClick={()=>onChange("")}>×</button>}</label>;
}
export function SaveState({children,warning=false,className=""}:{children:ReactNode;warning?:boolean;className?:string}){return <span className={`pt-save-state ${warning?"is-warning":""} ${className}`}><i aria-hidden="true"/>{children}</span>;}
export function SectionHeading({title,count,children}:{title:string;count?:number;children?:ReactNode}){return <div className="pt-section-heading"><h2>{title}{count!==undefined&&<span>{count}</span>}</h2><div>{children}</div></div>;}
export function RecordGrid({children,className=""}:{children:ReactNode;className?:string}){return <div className={`pt-record-grid ${className}`}>{children}</div>;}
export function ToolEntrances(){return <section className="pt-entrances" aria-label="記録を追加">{SUITE_TOOLS.filter(tool=>tool.id!=="atlas").map(tool=><a key={tool.id} href={tool.href}><span className="pt-tool-symbol" aria-hidden="true">{tool.symbol}</span><span><strong>{tool.name}</strong><small>{tool.description}</small></span><span aria-hidden="true">↗</span></a>)}</section>;}

export function SuiteShell({tool,title,status,warning,navigation,search,views,view,onViewChange,spaces,space,onSpaceChange,onAddSpace,onSettings,sidebarExtra,actions,children}:{
  tool:SuiteTool;title:string;status:string;warning?:boolean;navigation:SuiteNavigation;search:ReactNode;
  views:SuiteView[];view:string;onViewChange:(view:string)=>void;spaces:SuiteSpace[];space:string;onSpaceChange:(space:string)=>void;
  onAddSpace?:()=>void;onSettings:()=>void;sidebarExtra?:ReactNode;actions?:ReactNode;children:ReactNode;
}){
  const current=SUITE_TOOLS.find(item=>item.id===tool)!;
  return <div className="pt-shell" data-tool={tool} onClick={navigation.onClick}>
    <a className="pt-skip" href="#suite-content">本文へ移動</a>
    <aside className="pt-sidebar" aria-label="ナビゲーション" inert={navigation.pending||undefined}>
      <a className="pt-brand" href="/atlas/"><span className="pt-brand-mark">A</span>Atlas</a>
      <nav className="pt-tools" aria-label="ツール"><ToolLinks current={tool} disabled={navigation.blocked}/></nav>
      <nav className="pt-views" aria-label={`${current.name}の一覧`}>{views.map(item=><button key={item.id} type="button" className={!space&&view===item.id?"is-active":""} aria-pressed={!space&&view===item.id} onClick={()=>onViewChange(item.id)} disabled={navigation.pending}><span>{item.label}</span>{item.count!==undefined&&<small>{item.count}</small>}</button>)}</nav>
      <SpaceList spaces={spaces} value={space} onChange={onSpaceChange} onAdd={onAddSpace} disabled={navigation.pending}/>
      {sidebarExtra&&<div className="pt-sidebar-extra">{sidebarExtra}</div>}
      <button type="button" className="pt-settings" onClick={onSettings}>⚙ <span>保存とアカウント</span></button>
    </aside>
    <div className="pt-main">
      <header className="pt-topbar" inert={navigation.pending||undefined}><span className="pt-breadcrumb"><span className="pt-product-name">Personal tools</span><span>/</span><strong>{current.name}</strong></span><button type="button" className="pt-status-button" onClick={onSettings} aria-label={`保存状態: ${status}`}><SaveState warning={warning}>{status}</SaveState></button><button type="button" className="pt-lock-button" aria-label="金庫をロック" onClick={()=>window.dispatchEvent(new Event("personal-tools-lock"))}>ロック</button><button type="button" className="pt-settings-button" onClick={onSettings} aria-label="保存とアカウント">⚙</button></header>
      <nav className="pt-mobile-tools" aria-label="ツール切替" inert={navigation.pending||undefined}><ToolLinks current={tool} disabled={navigation.blocked}/></nav>
      <main id="suite-content" className="pt-content" inert={navigation.pending||undefined} aria-busy={navigation.pending}>
        <div className="pt-page-heading"><div><p>{current.name.toUpperCase()}</p><h1>{title}</h1></div>{search}</div>
        <div className="pt-mobile-filters"><label>表示<select aria-label="一覧の表示範囲" value={view} onChange={event=>onViewChange(event.target.value)}>{views.map(item=><option value={item.id} key={item.id}>{item.label}</option>)}</select></label><label>スペース<select aria-label="スペースで絞り込む" value={space} onChange={event=>onSpaceChange(event.target.value)}><option value="">すべてのスペース</option>{spaces.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select></label>{onAddSpace&&<button type="button" className="pt-mobile-add" onClick={onAddSpace} aria-label="スペースを追加">＋</button>}</div>
        {actions&&<div className="pt-page-actions">{actions}</div>}
        {children}
      </main>
      {navigation.pending&&<p className="pt-navigation-status" role="status">下書きを保存して移動しています…</p>}
    </div>
  </div>;
}

export function Modal({title,children,onClose,disabled=false}:{title:string;children:ReactNode;onClose:()=>void;disabled?:boolean}){
  const ref=useRef<HTMLDialogElement>(null),heading=useId(),latest=useRef({onClose,disabled});latest.current={onClose,disabled};
  useEffect(()=>{const dialog=ref.current;dialog?.showModal();return()=>dialog?.close();},[]);
  return <dialog ref={ref} className="pt-modal modal" aria-labelledby={heading} onCancel={event=>{event.preventDefault();if(!latest.current.disabled)latest.current.onClose();}}><div className="pt-modal-heading"><h2 id={heading}>{title}</h2><button type="button" onClick={onClose} disabled={disabled} aria-label="閉じる">×</button></div>{children}</dialog>;
}
