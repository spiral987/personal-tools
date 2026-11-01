import test from "node:test";
import assert from "node:assert/strict";
import {googleSignInLocation} from "../packages/auth/src/google.ts";
import {authCallbackErrorMessage} from "../packages/auth/src/index.ts";

type GoogleAuth=Parameters<typeof googleSignInLocation>[0];
test("Googleログインは既存PKCE callbackを同じoriginに固定し、追加scopeを要求しない",async()=>{
  for(const origin of ["https://tools.example","http://127.0.0.1:3100"]){
    let request:unknown;
    const auth={signInWithOAuth:async(value:unknown)=>{request=value;return {data:{url:"https://example.supabase.co/auth/v1/authorize?provider=google"},error:null};}} as unknown as GoogleAuth;
    assert.equal(await googleSignInLocation(auth,origin),"https://example.supabase.co/auth/v1/authorize?provider=google");
    assert.deepEqual(request,{provider:"google",options:{redirectTo:origin+"/recall/auth/callback/",skipBrowserRedirect:true}});
  }
});
test("Googleログインの失敗・URL欠落では遷移せず、サービスの詳細を画面へ出さない",async()=>{
  for(const result of [{data:{url:null},error:{message:"private-service-detail"}},{data:{url:null},error:null}]){
    const auth={signInWithOAuth:async()=>result} as unknown as GoogleAuth;
    await assert.rejects(googleSignInLocation(auth,"https://tools.example"),error=>error instanceof Error&&error.message.includes("開始できません")&&!error.message.includes("private-service-detail"));
  }
});
test("認証を中断した場合の案内はGoogleで再試行でき、任意のエラー詳細を表示しない",()=>{
  assert.match(authCallbackErrorMessage("link_failed"),/Googleログインをやり直す/);
  assert.match(authCallbackErrorMessage("not_configured"),/接続の設定/);
  assert.equal(authCallbackErrorMessage("private-error-detail"),authCallbackErrorMessage("link_failed"));
});
