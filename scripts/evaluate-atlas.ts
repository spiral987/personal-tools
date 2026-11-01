import {readFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";
export function evaluateAtlas(input:unknown){
 if(!Array.isArray(input)||input.length<20||input.length>30)throw new Error("本人が評価した20〜30件の検索記録を指定してください。");
 const ranks=input.map(row=>{
  if(!row||typeof row.query!=="string"||!row.query.trim()||!Array.isArray(row.expectedItemIds)||!row.expectedItemIds.length||!row.expectedItemIds.every((id:unknown)=>typeof id==="string"&&id)||!Array.isArray(row.rankedItemIds)||!row.rankedItemIds.every((id:unknown)=>typeof id==="string"&&id))throw new Error("各検索語に目的の原本IDと、検索結果の原本IDを記録してください。");
  const result=[...new Set(row.rankedItemIds)],index=result.findIndex(id=>row.expectedItemIds.includes(id));return index<0?Infinity:index+1;
 });
 return {queries:ranks.length,hitAt1:ranks.filter(r=>r<=1).length/ranks.length,hitAt5:ranks.filter(r=>r<=5).length/ranks.length,hitAt10:ranks.filter(r=>r<=10).length/ranks.length,meanReciprocalRank:ranks.reduce((sum,r)=>sum+(Number.isFinite(r)?1/r:0),0)/ranks.length,misses:ranks.filter(r=>!Number.isFinite(r)).length};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{if(!process.argv[2])throw new Error("評価JSONのパスを指定してください。");console.log(JSON.stringify(evaluateAtlas(JSON.parse(await readFile(process.argv[2],"utf8"))),null,2));}catch(e){console.error(e instanceof Error?e.message:"評価できませんでした。");process.exitCode=1;}}
