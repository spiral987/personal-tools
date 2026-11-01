import {createServerClient} from "@supabase/ssr";
import {NextResponse,type NextRequest} from "next/server";
import {getPublicSupabaseConfig} from "./index";
/** Documented getAll/setAll refresh pattern; getSession is not server authorization.
 * https://supabase.com/docs/guides/auth/server-side/creating-a-client?framework=nextjs
 */
export async function refreshAuthSession(request:NextRequest) {
  let response=NextResponse.next({request});
  const config=getPublicSupabaseConfig();if(!config)return response;
  const client=createServerClient(config.url,config.publishableKey,{
    cookieOptions:{path:"/",sameSite:"lax",secure:request.nextUrl.protocol==="https:"},
    cookies:{getAll:()=>request.cookies.getAll(),setAll(values){
      for(const {name,value} of values)request.cookies.set(name,value);
      response=NextResponse.next({request});
      for(const {name,value,options} of values)response.cookies.set(name,value,options);
    }},
  });
  // The public HTML shell must open offline. Sync RPCs independently validate JWT + RLS.
  try{await client.auth.getClaims();}catch{}
  response.headers.set("Cache-Control","private, no-store");return response;
}
