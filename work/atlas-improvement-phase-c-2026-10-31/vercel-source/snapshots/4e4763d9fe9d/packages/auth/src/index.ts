export type Identity = { mode: "device" } | { mode: "account"; userId: string };
export {createSharedSessionRefresh,type SharedSessionRefreshBoundary} from "./session-refresh.ts";
export const LOCAL_IDENTITY: Identity = { mode: "device" };

export type PublicSupabaseConfig = {url:string; publishableKey:string};
export const RECALL_HOME = "/recall/";
export const AUTH_CALLBACK = "/recall/auth/callback/";
export function getPublicSupabaseConfig():PublicSupabaseConfig|null {
  // Next.js inlines these explicit public env reads; no server secrets belong here.
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if(!url||!publishableKey)return null;
  try {
    const parsed=new URL(url);
    const local=["localhost","127.0.0.1","[::1]"].includes(parsed.hostname);
    if(parsed.protocol!=="https:"&&!(local&&parsed.protocol==="http:"))return null;
    if(parsed.username||parsed.password||publishableKey.startsWith("sb_secret_"))return null;
    if(publishableKey.split(".").length===3) {
      const body=publishableKey.split(".")[1].replace(/-/g,"+").replace(/_/g,"/");
      if((JSON.parse(atob(body)) as {role?:string}).role!=="anon")return null;
    }
    return {url:parsed.origin,publishableKey};
  }catch{return null;}
}
export function callbackLocation(origin:string):string {return new URL(AUTH_CALLBACK,origin).toString();}
export type AuthCallbackOutcome="success"|"not_configured"|"link_failed";
export function createAuthCallbackResponse(outcome:AuthCallbackOutcome):Response {
  if(!["success","not_configured","link_failed"].includes(outcome))throw new Error("Invalid auth callback outcome");
  const query=new URLSearchParams(outcome==="success"?{auth_success:"1"}:{auth_error:outcome});
  // A relative Location preserves the actual browser origin. NextURL normalizes 127.0.0.1 to
  // localhost, so deriving an absolute redirect from request.url can lose the cookie origin.
  return new Response(null,{status:303,headers:{
    Location:`${RECALL_HOME}?${query.toString()}`,
    "Cache-Control":"private, no-store",
    "Referrer-Policy":"no-referrer",
  }});
}
export function accountDatabaseName(userId:string,projectUrl:string):string {
  return `personal-tools-recall-account-${new URL(projectUrl).host}-${userId}`;
}
