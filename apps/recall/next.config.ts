import type {NextConfig} from "next";
import {sketchbookRewrites,collectRewrites,atlasRewrites} from "../../scripts/zones.mjs";
const config:NextConfig={
  basePath:"/recall",trailingSlash:true,
  transpilePackages:["@personal-tools/core","@personal-tools/api-client","@personal-tools/auth","@personal-tools/ui"],
  logging:{incomingRequests:{ignore:[/\/auth\/callback(?:\/|\?|$)/]}},
  async headers(){return [{source:"/:path*",headers:[{key:"Referrer-Policy",value:"no-referrer"},{key:"X-Content-Type-Options",value:"nosniff"},{key:"X-Frame-Options",value:"DENY"},{key:"Content-Security-Policy",value:"frame-ancestors 'none'; object-src 'none'; base-uri 'self'"}]},{source:"/",headers:[{key:"X-Recall-Public-Shell",value:"1"}]}];},
  // Same-origin entry point preserves both page slashes and file asset paths.
  // Each app keeps its own basePath, assets and SW scope.
  // https://nextjs.org/docs/app/guides/multi-zones
  async rewrites(){return {beforeFiles:[...sketchbookRewrites(process.env.SKETCHBOOK_ORIGIN),...collectRewrites(process.env.COLLECT_ORIGIN),...atlasRewrites(process.env.ATLAS_ORIGIN)],afterFiles:[],fallback:[]};},
};
export default config;
