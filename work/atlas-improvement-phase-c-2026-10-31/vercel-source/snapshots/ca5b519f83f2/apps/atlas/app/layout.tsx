import {VaultGate} from "@personal-tools/auth/vault";
import type {Metadata,Viewport} from "next";
import "./globals.css";
import "@personal-tools/ui/styles.css";
export const metadata:Metadata={title:"Atlas — 記録をつなぎ、見つける。",description:"思考、スケッチ、資料を横断して見つけ、活動へまとめる。",manifest:"/atlas/manifest.webmanifest",icons:{icon:"/atlas/icon.svg",apple:"/atlas/icon-192.png"},appleWebApp:{capable:true,title:"Atlas"}};
export const viewport:Viewport={width:"device-width",initialScale:1,themeColor:"#f4f3ee"};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="ja"><body><VaultGate>{children}</VaultGate></body></html>;}
