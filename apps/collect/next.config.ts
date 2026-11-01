import type {NextConfig} from "next";
const config:NextConfig={
  basePath:"/collect",trailingSlash:true,
  transpilePackages:["@personal-tools/core","@personal-tools/api-client","@personal-tools/auth","@personal-tools/ui"],
  // Share Target parameters can contain private text and source URLs.
  logging:{incomingRequests:false},
  async headers(){return [
    {source:"/:path*",headers:[{key:"Referrer-Policy",value:"no-referrer"},{key:"X-Content-Type-Options",value:"nosniff"},{key:"X-Frame-Options",value:"DENY"},{key:"Content-Security-Policy",value:"frame-ancestors 'none'; object-src 'none'; base-uri 'self'"}]},
    {source:"/",headers:[{key:"X-Collect-Public-Shell",value:"1"}]},
  ];},
};
export default config;
