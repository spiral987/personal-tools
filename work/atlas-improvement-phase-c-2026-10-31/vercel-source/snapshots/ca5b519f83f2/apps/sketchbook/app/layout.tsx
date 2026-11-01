import {VaultGate} from "@personal-tools/auth/vault";
import type {Metadata,Viewport} from "next";
import "./globals.css";
import "@personal-tools/ui/styles.css";
export const metadata:Metadata={title:"Sketchbook",description:"スケッチの作成・保存・編集",appleWebApp:{capable:true,title:"Sketchbook",statusBarStyle:"default"},icons:{icon:"/sketchbook/icon.svg",apple:"/sketchbook/icon-192.png"}};
export const viewport:Viewport={width:"device-width",initialScale:1,themeColor:"#f6f4ef"};
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){return <html lang="ja"><body><VaultGate>{children}</VaultGate></body></html>;}
