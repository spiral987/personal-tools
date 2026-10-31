import type {MetadataRoute} from "next";
/** Installed browsers that support Web Share Target can fill a draft; nothing is saved automatically.
 * https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target */
export default function manifest():MetadataRoute.Manifest{return {
  id:"/collect/",name:"Collect — 気になるものを集める",short_name:"Collect",
  description:"URLや画像を、出典と自分のメモと一緒に残す。",start_url:"/collect/",scope:"/collect/",
  display:"standalone",background_color:"#f6f4ef",theme_color:"#f6f4ef",lang:"ja",
  share_target:{action:"/collect/",method:"GET",params:{title:"title",text:"text",url:"url"}},
  icons:[{src:"/collect/icon-192.png",sizes:"192x192",type:"image/png"},{src:"/collect/icon-512.png",sizes:"512x512",type:"image/png"}],
};}
