import type {NextConfig} from "next";
const config:NextConfig={
  basePath:"/collect",trailingSlash:true,
  transpilePackages:["@personal-tools/core","@personal-tools/api-client","@personal-tools/auth"],
  // Share Target parameters can contain private text and source URLs.
  logging:{incomingRequests:false},
  async headers(){return [
    {source:"/:path*",headers:[{key:"Referrer-Policy",value:"no-referrer"}]},
    {source:"/",headers:[{key:"X-Collect-Public-Shell",value:"1"}]},
  ];},
};
export default config;
