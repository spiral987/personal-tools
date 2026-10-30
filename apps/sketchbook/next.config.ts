import type {NextConfig} from "next";
const config:NextConfig={
  basePath:"/sketchbook",trailingSlash:true,
  transpilePackages:["@personal-tools/core","@personal-tools/api-client","@personal-tools/auth"],
  async headers(){return [{source:"/",headers:[{key:"X-Sketchbook-Public-Shell",value:"1"}]}];},
};
export default config;
