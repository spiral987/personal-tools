import type {MetadataRoute} from "next";
export default function manifest():MetadataRoute.Manifest{
  return {id:"/sketchbook/",name:"Sketchbook — アイデアを描く",short_name:"Sketchbook",description:"浮かんだかたちを、すぐに残す。",start_url:"/sketchbook/",scope:"/sketchbook/",display:"standalone",background_color:"#f6f4ef",theme_color:"#f6f4ef",lang:"ja",icons:[{src:"/sketchbook/icon-192.png",sizes:"192x192",type:"image/png"},{src:"/sketchbook/icon-512.png",sizes:"512x512",type:"image/png"}]};
}
