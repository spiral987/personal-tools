import {createServerClient} from "@supabase/ssr";
import {cookies} from "next/headers";
import {getPublicSupabaseConfig} from "./index";
/** Request-scoped client. Never share a server client between requests or users. */
export async function createRequestAuthClient(secure=false) {
  const config=getPublicSupabaseConfig();if(!config)return null;
  const store=await cookies();
  return createServerClient(config.url,config.publishableKey,{
    cookieOptions:{path:"/",sameSite:"lax",secure},
    cookies:{getAll:()=>store.getAll(),setAll(values){
      // Official SSR pattern. Read-only Server Components rely on proxy.ts for refresh.
      try{for(const {name,value,options} of values)store.set(name,value,options);}catch{}
    }},
  });
}
