"use client";
import {useEffect,useState} from "react";
import type {ResourceFile} from "@personal-tools/core";

const imageTypes=new Set(["image/png","image/jpeg","image/gif","image/webp"]);
/** Only inert text, validated raster images and sandboxed PDFs have inline previews. */
export function OriginalPreview({file,blob,url}:{file:ResourceFile;blob:Blob|null;url?:string}){
  const [text,setText]=useState<string|null>(null);
  const textFile=/^(text\/(plain|markdown|csv)|application\/json)$/u.test(file.mimeType);
  useEffect(()=>{
    let active=true;setText(null);
    if(textFile&&blob&&blob.size<=2*1024*1024)void blob.text().then(value=>{if(active)setText(value);}).catch(()=>{});
    return()=>{active=false;};
  },[blob,textFile]);
  if(!url)return <p className="small-note">原本を読み込むとプレビューを表示します。</p>;
  if(imageTypes.has(file.mimeType))return <img className="original-image" src={url} alt={file.filename}/>;
  if(file.mimeType==="application/pdf")return <iframe className="original-pdf" title={`PDFプレビュー: ${file.filename}`} src={url} sandbox=""/>;
  if(text!==null)return <pre className="original-text">{text}</pre>;
  return <p className="small-note">この形式はダウンロードして対応アプリで開けます。{textFile&&blob&&blob.size>2*1024*1024?"2MBを超える文章はプレビューを省略します。":""}</p>;
}
