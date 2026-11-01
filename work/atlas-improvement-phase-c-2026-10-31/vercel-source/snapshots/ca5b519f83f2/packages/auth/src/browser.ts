import {createBrowserClient} from "@supabase/ssr";
import {getPublicSupabaseConfig} from "./index";
/** Official cookie/PKCE client: https://supabase.com/docs/guides/auth/server-side/creating-a-client */
export function getBrowserAuthClient() {
  const config=getPublicSupabaseConfig();if(!config)return null;
  return createBrowserClient(config.url,config.publishableKey,{
    cookieOptions:{path:"/",sameSite:"lax",secure:typeof window!=="undefined"&&window.location.protocol==="https:"},
    auth:{flowType:"pkce",detectSessionInUrl:false},
  });
}
export type BrowserAuthClient=NonNullable<ReturnType<typeof getBrowserAuthClient>>;
