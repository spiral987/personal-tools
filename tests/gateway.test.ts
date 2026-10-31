import test from "node:test";
import assert from "node:assert/strict";
import http,{type IncomingMessage} from "node:http";
import net from "node:net";
import {once} from "node:events";
import {createGatewayServer,getGatewayConfig} from "../scripts/gateway.mjs";

type Running={server:http.Server;port:number;close:()=>Promise<void>};
async function upstream(name:string):Promise<Running>{
  const connections=new Set<net.Socket>();
  const server=http.createServer((request,response)=>{
    if(request.url?.includes("stream")){response.writeHead(200,{"Content-Type":"text/plain","X-App":name});response.write("first-");setTimeout(()=>response.end("last"),5);return;}
    const body:Buffer[]=[];request.on("data",chunk=>body.push(chunk));request.on("end",()=>{
      response.writeHead(200,{"Content-Type":"application/json","X-App":name,"Set-Cookie":["test-session=one; Path=/; SameSite=Lax","test-verifier=two; Path=/; SameSite=Lax"]});
      response.end(JSON.stringify({app:name,path:request.url,method:request.method,cookie:request.headers.cookie,authorization:request.headers.authorization,host:request.headers.host,forwarded:request.headers["x-forwarded-host"],body:Buffer.concat(body).toString()}));
    });
  });
  server.on("connection",socket=>{connections.add(socket);socket.once("close",()=>connections.delete(socket));});
  server.on("upgrade",(request,socket,head)=>{
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test-relay\r\n\r\nbackend-head:");
    socket.write(`${name}:${request.url}:`);
    if(head.length)socket.write(head);
    socket.on("data",chunk=>socket.write(chunk));
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();assert.ok(address&&typeof address!=="string");
  return {server,port:address.port,close:async()=>{for(const socket of connections)socket.destroy();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}
async function request(port:number,path:string,method="GET",body=""){
  return await new Promise<{status:number;headers:IncomingMessage["headers"];body:string}>((resolve,reject)=>{
    const req=http.request({hostname:"127.0.0.1",port,path,method,headers:{Host:`127.0.0.1:${port}`,Cookie:"test-cookie=not-a-real-session",Authorization:"Bearer test-only","Content-Type":"text/plain"}},response=>{
      const chunks:Buffer[]=[];response.on("data",chunk=>chunks.push(chunk));response.once("end",()=>resolve({status:response.statusCode!,headers:response.headers,body:Buffer.concat(chunks).toString()}));response.once("error",reject);
    });req.once("error",reject);req.end(body);
  });
}
test("local gateway forwards exact paths, queries, cookies, HEAD, streamed bodies and independent app outages",async t=>{
  const recall=await upstream("recall"),sketch=await upstream("sketchbook"),collect=await upstream("collect");
  const gateway=createGatewayServer({recallPort:recall.port,sketchbookPort:sketch.port,collectPort:collect.port});
  gateway.server.listen(0,"127.0.0.1");await once(gateway.server,"listening");const address=gateway.server.address();assert.ok(address&&typeof address!=="string");const port=address.port;
  let recallClosed=false;
  t.after(async()=>{await gateway.close();if(!recallClosed)await recall.close();await sketch.close();await collect.close();});
  const path="/sketchbook/_next/static/%5Bchunk%5D.js?from=note%2Fone&item=sketch-1";
  const reply=await request(port,path,"POST","payload across chunks");assert.equal(reply.status,200);
  assert.deepEqual(JSON.parse(reply.body),{app:"sketchbook",path,method:"POST",cookie:"test-cookie=not-a-real-session",authorization:"Bearer test-only",host:`127.0.0.1:${port}`,forwarded:`127.0.0.1:${port}`,body:"payload across chunks"});
  assert.equal(reply.headers["set-cookie"]?.length,2);
  const head=await request(port,"/recall/","HEAD");assert.equal(head.status,200);assert.equal(head.body,"");assert.equal(head.headers["x-app"],"recall");
  assert.equal((await request(port,"/recall/stream")).body,"first-last");
  assert.equal((await request(port,"/")).headers.location,"/recall/");
  for(const invalid of ["/unknown/","/recall-foreign/","//example.com/recall/","http://example.com/recall/"]){assert.equal((await request(port,invalid)).status,404);}
  await recall.close();recallClosed=true;
  const down=await request(port,"/recall/");assert.equal(down.status,503);assert.equal(down.headers["cache-control"],"no-store");
  assert.equal((await request(port,"/sketchbook/")).status,200);
  const collected=await request(port,"/collect/?url=https%3A%2F%2Fexample.com%2F");assert.equal(collected.status,200);assert.equal(JSON.parse(collected.body).app,"collect");
});
test("local gateway routes Upgrade handshakes and buffered bidirectional bytes to the correct HMR backend",async t=>{
  const recall=await upstream("recall"),sketch=await upstream("sketchbook"),collect=await upstream("collect");
  const gateway=createGatewayServer({recallPort:recall.port,sketchbookPort:sketch.port,collectPort:collect.port});
  gateway.server.listen(0,"127.0.0.1");await once(gateway.server,"listening");const address=gateway.server.address();assert.ok(address&&typeof address!=="string");
  const client=net.connect(address.port,"127.0.0.1");t.after(async()=>{client.destroy();await gateway.close();await recall.close();await sketch.close();await collect.close();});await once(client,"connect");
  const received:Buffer[]=[];let resolveBytes:(value:string)=>void=()=>{};let rejectBytes:(error:Error)=>void=()=>{};
  const result=new Promise<string>((resolve,reject)=>{resolveBytes=resolve;rejectBytes=reject;});
  client.on("data",chunk=>{received.push(chunk);const text=Buffer.concat(received).toString();if(text.includes("first-client-bytes")&&!text.includes("second-client-bytes"))client.write("second-client-bytes");if(text.includes("second-client-bytes"))resolveBytes(text);});
  client.once("error",rejectBytes);
  const timer=setTimeout(()=>rejectBytes(new Error("Upgrade relay did not exchange bytes")),3000);t.after(()=>clearTimeout(timer));
  client.write(`GET /collect/_next/webpack-hmr?token=test-only HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nConnection: Upgrade\r\nUpgrade: test-relay\r\nCookie: test-session=not-real\r\n\r\nfirst-client-bytes`);
  const text=await result;assert.match(text,/^HTTP\/1\.1 101 Switching Protocols/);assert.ok(text.includes("backend-head:collect:/collect/_next/webpack-hmr?token=test-only:first-client-bytes"));assert.ok(text.includes("second-client-bytes"));
});
test("local gateway configuration keeps public origin stable and validates distinct loopback ports",()=>{
  assert.deepEqual(getGatewayConfig({}),{gatewayPort:3100,recallPort:3102,sketchbookPort:3101,collectPort:3103});
  assert.deepEqual(getGatewayConfig({RECALL_PORT:"3300"}),{gatewayPort:3300,recallPort:3302,sketchbookPort:3301,collectPort:3303});
  assert.deepEqual(getGatewayConfig({GATEWAY_PORT:"3400",RECALL_PORT:"3300",RECALL_BACKEND_PORT:"3408",SKETCHBOOK_PORT:"3409"}),{gatewayPort:3400,recallPort:3408,sketchbookPort:3409,collectPort:3403});
  for(const env of [{GATEWAY_PORT:"80"},{GATEWAY_PORT:"65535"},{SKETCHBOOK_PORT:"3100"},{COLLECT_PORT:"3102"},{RECALL_BACKEND_PORT:"not-a-port"}])assert.throws(()=>getGatewayConfig(env));
});
