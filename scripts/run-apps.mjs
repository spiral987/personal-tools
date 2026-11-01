import {spawn} from "node:child_process";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {getGatewayConfig,startGateway} from "./gateway.mjs";
import {sketchbookOrigin,collectOrigin,atlasOrigin} from "./zones.mjs";

const mode=process.argv[2];
if(!["dev","start"].includes(mode))throw new Error("Expected dev or start.");
const root=fileURLToPath(new URL("../",import.meta.url));
const config=getGatewayConfig();
const env={...process.env,SKETCHBOOK_ORIGIN:sketchbookOrigin(process.env.SKETCHBOOK_ORIGIN??`http://127.0.0.1:${config.sketchbookPort}`),COLLECT_ORIGIN:collectOrigin(process.env.COLLECT_ORIGIN??`http://127.0.0.1:${config.collectPort}`),ATLAS_ORIGIN:atlasOrigin(process.env.ATLAS_ORIGIN??`http://127.0.0.1:${config.atlasPort}`)};
// Upgrade requests must reach each app's own HMR server before Next handles them.
// A separate gateway keeps the browser origin stable for cookies and IndexedDB.
const gateway=await startGateway(config);
const children=[];let stopping=false;
async function terminate(child){
  if(child.exitCode!==null||child.signalCode!==null||child.pid===undefined)return;
  if(process.platform==="win32")await new Promise(resolve=>{const killer=spawn("taskkill.exe",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});killer.once("exit",resolve);killer.once("error",resolve);});
  else child.kill("SIGTERM");
}
async function stop(code){if(stopping)return;stopping=true;process.exitCode=code;await Promise.all([gateway.close(),...children.map(terminate)]);}
process.once("SIGINT",()=>void stop(0));process.once("SIGTERM",()=>void stop(0));
try{
  for(const [app,appPort] of [["recall",config.recallPort],["sketchbook",config.sketchbookPort],["collect",config.collectPort],["atlas",config.atlasPort]]){
    const cwd=path.join(root,"apps",app);
    const require=createRequire(path.join(cwd,"package.json"));
    const next=require.resolve("next/dist/bin/next");
    const child=spawn(process.execPath,[next,mode,"--hostname","127.0.0.1","--port",String(appPort)],{cwd,env,stdio:"inherit",windowsHide:true});
    children.push(child);
    child.once("error",()=>{console.error(`${app} could not start. The other apps remain available.`);process.exitCode=1;});
    child.once("exit",code=>{if(!stopping){console.error(`${app} stopped (exit ${code??"signal"}). The other apps remain available.`);process.exitCode=1;}});
  }
}catch(error){console.error(error.message);await stop(1);}
console.log(`Home: http://127.0.0.1:${config.gatewayPort}/`);
console.log(`Recall: http://127.0.0.1:${config.gatewayPort}/recall/`);
console.log(`Sketchbook: http://127.0.0.1:${config.gatewayPort}/sketchbook/`);
console.log(`Atlas: http://127.0.0.1:${config.gatewayPort}/atlas/`);
console.log(`Collect: http://127.0.0.1:${config.gatewayPort}/collect/`);
