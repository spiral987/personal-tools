// This build never sends decrypted vault contents to an external AI service.
export const runtime="nodejs";
export function GET(){return Response.json({configured:false,model:null,embeddingModel:null,reason:"encrypted-vault"},{headers:{"Cache-Control":"no-store"}});}
export function POST(){return Response.json({error:"暗号化金庫では外部AIへの送信を停止しています。端末内の検索をご利用ください。"},{status:410,headers:{"Cache-Control":"no-store"}});}