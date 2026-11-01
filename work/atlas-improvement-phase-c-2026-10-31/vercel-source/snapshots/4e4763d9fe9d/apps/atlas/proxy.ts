import type {NextRequest} from "next/server";
import {refreshAuthSession} from "@personal-tools/auth/proxy";
export async function proxy(request:NextRequest){return refreshAuthSession(request);}
export const config={matcher:["/api/:path*"]};
