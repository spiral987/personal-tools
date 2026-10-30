import test from "node:test";
import assert from "node:assert/strict";
import {getPublicSupabaseConfig,callbackLocation,accountDatabaseName,createAuthCallbackResponse,type AuthCallbackOutcome} from "../packages/auth/src/index.ts";

function configured(url:string|undefined,key:string|undefined){
  const originalUrl=process.env.NEXT_PUBLIC_SUPABASE_URL,originalKey=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  try{
    if(url===undefined)delete process.env.NEXT_PUBLIC_SUPABASE_URL;else process.env.NEXT_PUBLIC_SUPABASE_URL=url;
    if(key===undefined)delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;else process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=key;
    return getPublicSupabaseConfig();
  }finally{
    if(originalUrl===undefined)delete process.env.NEXT_PUBLIC_SUPABASE_URL;else process.env.NEXT_PUBLIC_SUPABASE_URL=originalUrl;
    if(originalKey===undefined)delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;else process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=originalKey;
  }
}
test("設定なし・片方のみの設定はローカル版を起動可能にする",()=>{
  assert.equal(configured(undefined,undefined),null);
  assert.equal(configured("https://example.supabase.co",undefined),null);
});
test("秘密鍵とservice_role JWTは公開接続設定として受け付けない",()=>{
  assert.equal(configured("https://example.supabase.co","sb_secret_private"),null);
  const jwt=`header.${Buffer.from(JSON.stringify({role:"service_role"})).toString("base64url")}.signature`;
  assert.equal(configured("https://example.supabase.co",jwt),null);
});
test("公開キーのHTTPS接続とローカルSupabaseのみを許可",()=>{
  assert.ok(configured("https://example.supabase.co","sb_publishable_public"));
  assert.ok(configured("http://127.0.0.1:54321","sb_publishable_public"));
  assert.equal(configured("http://external.example","sb_publishable_public"),null);
  assert.equal(configured("https://user:password@example.supabase.co","sb_publishable_public"),null);
});
test("認証後の入口は常に同じoriginの固定コールバック",()=>{
  assert.equal(callbackLocation("https://example.com"),"https://example.com/recall/auth/callback/");
  assert.equal(callbackLocation("http://127.0.0.1:3100"),"http://127.0.0.1:3100/recall/auth/callback/");
});
test("同じユーザーIDでも別プロジェクトの端末キャッシュを分離",()=>{
  assert.notEqual(accountDatabaseName("same-user","https://first.supabase.co"),accountDatabaseName("same-user","https://second.supabase.co"));
  assert.notEqual(accountDatabaseName("first-user","https://first.supabase.co"),accountDatabaseName("second-user","https://first.supabase.co"));
});
test("認証callbackの全結果は固定の相対Locationと非キャッシュ303を返す",()=>{
  for(const [outcome,location] of [["success","/recall/?auth_success=1"],["not_configured","/recall/?auth_error=not_configured"],["link_failed","/recall/?auth_error=link_failed"]] as const){
    const response=createAuthCallbackResponse(outcome);
    assert.equal(response.status,303);assert.equal(response.headers.get("location"),location);
    assert.equal(response.headers.get("cache-control"),"private, no-store");
    assert.equal(response.headers.get("referrer-policy"),"no-referrer");
  }
});
test("認証callbackから戻っても127.0.0.1・localhost・公開originを切り替えない",()=>{
  const location=createAuthCallbackResponse("success").headers.get("location")!;
  for(const origin of ["http://127.0.0.1:3300","http://localhost:3300","https://tools.example.com"]){
    const final=new URL(location,`${origin}/recall/auth/callback/?code=private-code&next=https://invalid.example`);
    assert.equal(final.origin,origin);assert.equal(final.pathname,"/recall/");
    assert.equal(final.search,"?auth_success=1");assert.equal(final.searchParams.has("code"),false);assert.equal(final.searchParams.has("next"),false);
  }
});
test("未知のcallback結果に秘密やURLを渡してもLocationへ反映しない",()=>{
  assert.throws(()=>createAuthCallbackResponse("https://invalid.example/?token=private" as AuthCallbackOutcome),/Invalid auth callback outcome/);
});
