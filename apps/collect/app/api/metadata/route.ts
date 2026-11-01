export const runtime="nodejs";
export const dynamic="force-dynamic";
export function POST(){return Response.json({error:"暗号化金庫ではURL情報の自動取得を停止しています。タイトルは手入力できます。"},{status:410,headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});}