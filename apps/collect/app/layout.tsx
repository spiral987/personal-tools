import {VaultGate} from "@personal-tools/auth/vault";
import type {Metadata,Viewport} from "next";
import "./globals.css";
import "@personal-tools/ui/styles.css";
export const metadata:Metadata={title:"Collect",description:"URL・画像・出典・メモを保存",manifest:"/collect/manifest.webmanifest",icons:{icon:"/collect/icon.svg",apple:"/collect/icon-192.png"},appleWebApp:{capable:true,statusBarStyle:"default",title:"Collect"}};
export const viewport:Viewport={width:"device-width",initialScale:1,themeColor:"#f6f4ef"};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="ja"><body><VaultGate>{children}</VaultGate></body></html>;}
