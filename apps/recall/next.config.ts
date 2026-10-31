import type {NextConfig} from "next";
import {sketchbookRewrites,collectRewrites} from "../../scripts/zones.mjs";
const config:NextConfig={
  basePath:"/recall",trailingSlash:true,
  transpilePackages:["@personal-tools/core","@personal-tools/api-client","@personal-tools/auth","@personal-tools/ui"],
  logging:{incomingRequests:{ignore:[/\/auth\/callback(?:\/|\?|$)/]}},
  async headers(){return [{source:"/",headers:[{key:"X-Recall-Public-Shell",value:"1"}]}];},
  // Same-origin entry point preserves both page slashes and file asset paths.
  // Each app keeps its own basePath, assets and SW scope.
  // https://nextjs.org/docs/app/guides/multi-zones
  async rewrites(){return {beforeFiles:[...sketchbookRewrites(process.env.SKETCHBOOK_ORIGIN),...collectRewrites(process.env.COLLECT_ORIGIN)],afterFiles:[],fallback:[]};},
};
export default config;
