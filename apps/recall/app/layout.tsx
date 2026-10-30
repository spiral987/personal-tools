import type { Metadata, Viewport } from "next";
import "./globals.css";
export const metadata:Metadata={title:"Recall — ふと浮かんだことを。",description:"日々の思考を、すぐに残して、また出会う。",appleWebApp:{capable:true,title:"Recall",statusBarStyle:"default"},icons:{icon:"/recall/icon.svg",apple:"/recall/icon-192.png"}};
export const viewport:Viewport={width:"device-width",initialScale:1,themeColor:"#f7f6f2"};
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>) { return <html lang="ja"><body>{children}</body></html>; }
