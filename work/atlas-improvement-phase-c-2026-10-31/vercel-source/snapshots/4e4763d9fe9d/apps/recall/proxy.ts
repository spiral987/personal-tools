import type {NextRequest} from "next/server";
import {refreshAuthSession} from "@personal-tools/auth/proxy";
export async function proxy(request:NextRequest){return refreshAuthSession(request);}
// Recall renders an anonymous shell; the browser owns its session and RPCs enforce RLS.
// Only server auth routes need cookie refresh. Avoid intercepting the basePath root.
export const config={matcher:["/auth/:path*"]};
