import {VaultGate} from "@personal-tools/auth/vault";
import type { Metadata, Viewport } from "next";
import "./globals.css";
import "@personal-tools/ui/styles.css";
export const metadata:Metadata={title:"Recall",description:"メモの作成・検索・整理",appleWebApp:{capable:true,title:"Recall",statusBarStyle:"default"},icons:{icon:"/recall/icon.svg",apple:"/recall/icon-192.png"}};
export const viewport:Viewport={width:"device-width",initialScale:1,themeColor:"#f7f6f2"};
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>) { return <html lang="ja"><body><VaultGate>{children}</VaultGate></body></html>; }
