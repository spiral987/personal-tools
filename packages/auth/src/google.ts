import type {BrowserAuthClient} from "./browser.ts";
import {callbackLocation} from "./index.ts";

/** Use the cookie client's PKCE flow and the existing request-scoped callback. */
export async function googleSignInLocation(auth:Pick<BrowserAuthClient["auth"],"signInWithOAuth">,origin:string){
  const {data,error}=await auth.signInWithOAuth({provider:"google",options:{redirectTo:callbackLocation(origin),skipBrowserRedirect:true}});
  if(error||!data.url)throw new Error("Googleログインを開始できませんでした。通信状態を確認して、もう一度お試しください。");
  return data.url;
}
