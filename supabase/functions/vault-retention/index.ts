import {createClient} from "npm:@supabase/supabase-js@2.118.0";
import {handleRetention} from "./handler.ts";
// Hosted runtime supplies this credential. It is never returned, logged, or included in browser builds.
const client=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false,autoRefreshToken:false}});
Deno.serve((request:Request)=>handleRetention(request,client));
