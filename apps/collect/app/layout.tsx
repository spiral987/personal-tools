import type {Metadata,Viewport} from "next";
import "./globals.css";
export const metadata:Metadata={title:"Collect — 気になるものを集める。",description:"URLや画像を、出典と自分のメモと一緒に残す。",manifest:"/collect/manifest.webmanifest",icons:{icon:"/collect/icon.svg",apple:"/collect/icon-192.png"},appleWebApp:{capable:true,statusBarStyle:"default",title:"Collect"}};
export const viewport:Viewport={width:"device-width",initialScale:1,themeColor:"#f6f4ef"};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="ja"><body>{children}</body></html>;}
