import type {NextRequest} from "next/server";
import {createRequestAuthClient} from "@personal-tools/auth/server";
import {createAuthCallbackResponse} from "@personal-tools/auth";
export const dynamic="force-dynamic";
export async function GET(request:NextRequest) {
  const client=await createRequestAuthClient(request.nextUrl.protocol==="https:");
  if(!client)return createAuthCallbackResponse("not_configured");
  const code=request.nextUrl.searchParams.get("code"),tokenHash=request.nextUrl.searchParams.get("token_hash"),type=request.nextUrl.searchParams.get("type");
  let outcome:"success"|"link_failed"="link_failed";
  try{
    // Documented email-template flow, plus same-browser PKCE code callbacks.
    // https://supabase.com/docs/guides/auth/auth-email-passwordless#with-magic-link
    const result=tokenHash&&type==="email"?await client.auth.verifyOtp({token_hash:tokenHash,type:"email"}):code?await client.auth.exchangeCodeForSession(code):null;
    if(result&&!result.error)outcome="success";
  }catch{}
  // Accept no arbitrary `next`, and never put codes/tokens/raw errors in redirects.
  return createAuthCallbackResponse(outcome);
}
