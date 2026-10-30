import http from "node:http";
import {pathToFileURL} from "node:url";

function port(value,fallback,name){
  const text=String(value??fallback);
  if(!/^\d+$/.test(text)||Number(text)<1024||Number(text)>65535)throw new Error(`Invalid ${name}`);
  return Number(text);
}
export function getGatewayConfig(env=process.env){
  // RECALL_PORT remains a compatibility alias for the public entry used in Phase 2.
  const gatewayPort=port(env.GATEWAY_PORT??env.RECALL_PORT,3100,"GATEWAY_PORT");
  const recallPort=port(env.RECALL_BACKEND_PORT,gatewayPort+2,"RECALL_BACKEND_PORT");
  const sketchbookPort=port(env.SKETCHBOOK_PORT,gatewayPort+1,"SKETCHBOOK_PORT");
  if(new Set([gatewayPort,recallPort,sketchbookPort]).size!==3)throw new Error("The gateway and app backends require different ports.");
  return {gatewayPort,recallPort,sketchbookPort};
}
function upstreamPort(rawUrl,config){
  if(typeof rawUrl!=="string"||!rawUrl.startsWith("/")||rawUrl.startsWith("//"))return null;
  const pathname=rawUrl.split("?",1)[0];
  if(/^\/recall(?:\/|$)/.test(pathname))return config.recallPort;
  if(/^\/sketchbook(?:\/|$)/.test(pathname))return config.sketchbookPort;
  return null;
}
function forwardedHeaders(request){
  // Never log request headers: they may contain session cookies or PKCE codes.
  return {...request.headers,"x-forwarded-host":request.headers.host??"","x-forwarded-proto":"http"};
}
function unavailable(response){
  if(response.headersSent){response.destroy();return;}
  response.writeHead(503,{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store","Retry-After":"2"});
  response.end("このツールを開けません。起動し直してから、再読み込みしてください。");
}
/** A local, fixed-route HTTP/Upgrade relay. No request can select an arbitrary upstream.
 * Node's documented request/upgrade streams preserve the original app path and query.
 * https://nodejs.org/api/http.html#event-upgrade
 */
export function createGatewayServer(config){
  const sockets=new Set();
  const server=http.createServer((request,response)=>{
    if(request.url==="/"){
      response.writeHead(302,{Location:"/recall/","Cache-Control":"no-store"});response.end();return;
    }
    const target=upstreamPort(request.url,config);
    if(target===null){response.writeHead(404,{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store"});response.end("このページはありません。");return;}
    const upstream=http.request({hostname:"127.0.0.1",port:target,method:request.method,path:request.url,headers:forwardedHeaders(request)},incoming=>{
      response.writeHead(incoming.statusCode??502,incoming.statusMessage,incoming.headers);
      incoming.once("error",()=>response.destroy());
      incoming.pipe(response);
    });
    upstream.once("error",()=>unavailable(response));
    request.once("aborted",()=>upstream.destroy());
    request.once("error",()=>upstream.destroy());
    response.once("close",()=>{if(!response.writableEnded)upstream.destroy();});
    request.pipe(upstream);
  });
  server.on("connection",socket=>{sockets.add(socket);socket.once("close",()=>sockets.delete(socket));});
  server.on("upgrade",(request,client,head)=>{
    const target=upstreamPort(request.url,config);
    if(target===null){client.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");return;}
    const upstream=http.request({hostname:"127.0.0.1",port:target,method:request.method,path:request.url,headers:forwardedHeaders(request)});
    const fail=()=>{if(!client.destroyed)client.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n");};
    upstream.once("error",fail);
    client.once("error",()=>upstream.destroy());
    client.once("close",()=>upstream.destroy());
    upstream.once("response",incoming=>{
      client.write(`HTTP/1.1 ${incoming.statusCode??502} ${incoming.statusMessage??""}\r\n`);
      for(let index=0;index<incoming.rawHeaders.length;index+=2)client.write(`${incoming.rawHeaders[index]}: ${incoming.rawHeaders[index+1]}\r\n`);
      client.write("Connection: close\r\n\r\n");incoming.pipe(client);
    });
    upstream.once("upgrade",(incoming,backend,backendHead)=>{
      client.write(`HTTP/1.1 ${incoming.statusCode??101} ${incoming.statusMessage??"Switching Protocols"}\r\n`);
      for(let index=0;index<incoming.rawHeaders.length;index+=2)client.write(`${incoming.rawHeaders[index]}: ${incoming.rawHeaders[index+1]}\r\n`);
      client.write("\r\n");
      if(backendHead.length)client.write(backendHead);
      if(head.length)backend.write(head);
      client.pipe(backend);backend.pipe(client);
      backend.once("error",()=>client.destroy());client.once("error",()=>backend.destroy());
      backend.once("close",()=>client.destroy());client.once("close",()=>backend.destroy());
    });
    upstream.end();
  });
  return {server,close:async()=>{for(const socket of sockets)socket.destroy();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}
export async function startGateway(config=getGatewayConfig()){
  const gateway=createGatewayServer(config);
  await new Promise((resolve,reject)=>{gateway.server.once("error",reject);gateway.server.listen(config.gatewayPort,"127.0.0.1",resolve);});
  return gateway;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const config=getGatewayConfig();
  const gateway=await startGateway(config);
  console.log(`Personal Tools: http://127.0.0.1:${config.gatewayPort}/recall/`);
  let closing=false;const stop=()=>{if(closing)return;closing=true;void gateway.close().catch(()=>{process.exitCode=1;});};
  process.once("SIGINT",stop);process.once("SIGTERM",stop);
}
