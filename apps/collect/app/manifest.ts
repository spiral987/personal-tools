import type {MetadataRoute} from "next";
// GET share targets put private text in server requests and browser history.
// The encrypted build accepts pasted URLs and files inside the unlocked vault.
export default function manifest():MetadataRoute.Manifest{return {
  id:"/collect/",name:"Collect",short_name:"Collect",
  description:"URL・画像・出典・メモを保存",start_url:"/collect/",scope:"/collect/",
  display:"standalone",background_color:"#f6f4ef",theme_color:"#f6f4ef",lang:"ja",
  icons:[{src:"/collect/icon-192.png",sizes:"192x192",type:"image/png"},{src:"/collect/icon-512.png",sizes:"512x512",type:"image/png"}],
};}
