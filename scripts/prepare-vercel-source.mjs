import {readdir,readFile,writeFile,mkdir} from "node:fs/promises";
import {createHash} from "node:crypto";
import {dirname} from "node:path";
const output="work/atlas-improvement-phase-c-2026-10-31/vercel-source";
const paths=["package.json","pnpm-lock.yaml","pnpm-workspace.yaml","scripts/zones.mjs","scripts/zones.d.mts"];
async function walk(folder){for(const entry of await readdir(folder,{withFileTypes:true})){if(entry.name.startsWith(".")||["node_modules","AGENTS.md","README.md","tsconfig.tsbuildinfo","next-env.d.ts"].includes(entry.name))continue;const file=`${folder}/${entry.name}`;if(entry.isDirectory())await walk(file);else if(/\.(?:tsx?|m[jt]s|css|json|svg|png|ico|js)$/.test(entry.name))paths.push(file);}}
await walk("apps");await walk("packages");await mkdir(output,{recursive:true});
const files=[];
for(const file of paths){const bytes=await readFile(file);files.push({file,sha:createHash("sha1").update(bytes).digest("hex"),size:bytes.length,data:bytes.toString("base64")});}
await writeFile(`${output}/manifest.json`,JSON.stringify(files.map(({data,...file})=>file),null,2));
const snapshot=createHash("sha256").update(JSON.stringify(files.map(({data,...file})=>file))).digest("hex").slice(0,12),directory=`${output}/snapshots/${snapshot}`;
for(const file of files){const target=`${directory}/${file.file}`;await mkdir(dirname(target),{recursive:true});await writeFile(target,Buffer.from(file.data,"base64"));}
// Bounded chunks transport source through the connected deployment tool.
let chunk=[],size=0,index=0;for(const file of files){if(size+file.data.length>18000&&chunk.length){await writeFile(`${output}/chunk-${index++}.json`,JSON.stringify(chunk));chunk=[];size=0;}chunk.push(file);size+=file.data.length;}if(chunk.length)await writeFile(`${output}/chunk-${index++}.json`,JSON.stringify(chunk));
console.log(JSON.stringify({files:files.length,bytes:files.reduce((n,f)=>n+f.size,0),chunks:index,directory}));
