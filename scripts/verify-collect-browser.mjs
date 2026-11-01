import http from "node:http";
import net from "node:net";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import ts from "typescript";

// Isolated origin: never open the user's normal localhost storage for tests.
const root = fileURLToPath(new URL("../", import.meta.url));
const port = Number(process.env.COLLECT_VERIFY_PORT ?? 3190);
const gatewayPort = Number(process.env.COLLECT_VERIFY_GATEWAY_PORT ?? 3191);
await mkdir(path.join(root,"work/atlas-improvement-2026-10-31"),{recursive:true});
const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  response.setHeader("Cache-Control", "no-store");
  try {
    if (pathname === "/__verify/results" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) { body += chunk; if (body.length > 100000) throw new Error("Result too large"); }
      const result = JSON.parse(body);
      await writeFile(path.join(root, "work/atlas-improvement-2026-10-31/browser-results.json"), JSON.stringify(result, null, 2));
      response.end("ok"); return;
    }
    let filename;
    if (pathname === "/__verify/") filename = "tests/browser/collect.html";
    else if (pathname.startsWith("/__verify/")) filename = "tests/browser/" + pathname.slice("/__verify/".length);
    else if (pathname === "/hash-wasm.js") filename = "packages/api-client/node_modules/hash-wasm/dist/index.esm.js";
    else if (/^\/packages\/(core|api-client)\/src\/[\w-]+\.ts$/.test(pathname)) filename = pathname.slice(1);
    if (filename) {
      const absolute = path.resolve(root, filename);
      if (!absolute.startsWith(root) || filename.includes("..")) throw new Error("Invalid path");
      let source = await readFile(absolute, "utf8");
      if (filename.endsWith(".ts")) source = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022}}).outputText;
      response.setHeader("Content-Type", filename.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8");
      response.end(source); return;
    }
    const upstream = http.request({hostname: "127.0.0.1", port: gatewayPort, path: request.url, method: request.method, headers: {...request.headers, host: `127.0.0.1:${port}`}}, incoming => {
      response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response);
    });
    upstream.on("error", () => {response.statusCode = 503; response.end("Start the apps with node scripts/run-apps.mjs dev");});
    request.pipe(upstream);
  } catch (error) { response.statusCode = 500; response.end(String(error)); }
});
// Next's development client waits for its HMR WebSocket before hydration.
server.on("upgrade",(request,socket,head)=>{
  const upstream=net.connect(gatewayPort,"127.0.0.1",()=>{
    let headers=`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`;
    for(let i=0;i<request.rawHeaders.length;i+=2)headers+=`${request.rawHeaders[i]}: ${request.rawHeaders[i+1]}\r\n`;
    upstream.write(headers+"\r\n");if(head.length)upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error",()=>socket.destroy());socket.on("error",()=>upstream.destroy());
  socket.on("close",()=>upstream.destroy());upstream.on("close",()=>socket.destroy());
});
server.listen(port, "127.0.0.1", () => console.log(`Native IndexedDB verification: http://127.0.0.1:${port}/__verify/`));
