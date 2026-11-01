"use client";
import type {ReactNode} from "react";
export {Modal} from "@personal-tools/ui";
export type IconName="inbox"|"grid"|"image"|"link"|"plus"|"arrow"|"external"|"trash"|"restore"|"close"|"download"|"upload"|"search"|"check"|"settings"|"star"|"file"|"retry";
export function Icon({name,size=18}:{name:IconName;size?:number}){
  const shapes:Record<IconName,ReactNode>={
    inbox:<><path d="m4 4-2 12v5h20v-5L20 4Z"/><path d="M2 15h6l2 3h4l2-3h6"/></>,
    grid:<><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    image:<><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="15.5" cy="8.5" r="1.5"/><path d="m3 17 6-7 6 6 3-3 3 3"/></>,
    link:<><path d="m9 15 6-6M6 13l-2 2a4 4 0 0 0 5 6l4-4M11 7l4-4a4 4 0 0 1 6 5l-2 2"/></>,
    plus:<path d="M12 4v16M4 12h16"/>,arrow:<path d="M4 12h16m-6-6 6 6-6 6"/>,external:<><path d="M14 3h7v7m-10 3L21 3M10 3H3v18h18v-7"/></>,
    trash:<><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/></>,restore:<><path d="m7 4-4 4 4 4"/><path d="M3 8h10a7 7 0 1 1-7 9"/></>,close:<path d="m6 6 12 12M6 18 18 6"/>,
    download:<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>,upload:<path d="M12 16V3m-5 5 5-5 5 5M4 17v4h16v-4"/>,search:<><circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6"/></>,check:<path d="m5 12 4 4L20 5"/>,
    settings:<><circle cx="12" cy="12" r="3"/><path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3Z"/></>,star:<path d="m12 2 3 6 7 1-5 5 1 8-6-4-6 4 1-8-5-5 7-1Z"/>,file:<><path d="M5 2h9l5 5v15H5Z"/><path d="M14 2v6h5M8 12h8M8 16h6"/></>,retry:<><path d="M21 4v6h-6M3 20v-6h6"/><path d="M4 9a8 8 0 0 1 13-5l4 6M3 14l4 6a8 8 0 0 0 13-5"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shapes[name]}</svg>;
}
export function EmptyCollection(){return <svg className="empty-art" width="116" height="96" viewBox="0 0 116 96" fill="none" aria-hidden="true"><rect x="22" y="12" width="46" height="61" rx="4" transform="rotate(-12 22 12)" fill="#e5e2d9" stroke="#b2aa9c"/><rect x="47" y="20" width="46" height="61" rx="4" transform="rotate(9 47 20)" fill="#faf8f3" stroke="#b2aa9c"/><path d="m55 62 12-15 9 10 7-6M57 70h23" stroke="#a49a87" strokeWidth="1.5"/><circle cx="77" cy="38" r="4" stroke="#a49a87"/><path d="M22 81h16M97 12v10M92 17h10" stroke="#b2aa9c" strokeWidth="1.5"/></svg>;}
