import type { MetadataRoute } from "next";
export default function manifest():MetadataRoute.Manifest {
  return {id:"/recall/",name:"Recall — 日々の思考メモ",short_name:"Recall",description:"ふと浮かんだことを、すぐに残す。",start_url:"/recall/",scope:"/recall/",display:"standalone",background_color:"#f7f6f2",theme_color:"#f7f6f2",lang:"ja",icons:[{src:"/recall/icon-192.png",sizes:"192x192",type:"image/png"},{src:"/recall/icon-512.png",sizes:"512x512",type:"image/png"}]};
}
