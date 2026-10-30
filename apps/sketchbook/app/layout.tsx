import type {Metadata,Viewport} from "next";
import "./globals.css";
export const metadata:Metadata={title:"Sketchbook — かたちに残す。",description:"浮かんだ構図やアイデアを、すぐに描いて残す。",appleWebApp:{capable:true,title:"Sketchbook",statusBarStyle:"default"},icons:{icon:"/sketchbook/icon.svg",apple:"/sketchbook/icon-192.png"}};
export const viewport:Viewport={width:"device-width",initialScale:1,themeColor:"#f6f4ef"};
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){return <html lang="ja"><body>{children}</body></html>;}
