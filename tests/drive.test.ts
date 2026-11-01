import test from "node:test";
import assert from "node:assert/strict";
import {createDriveClient,driveUploadMarker,DriveError} from "../packages/api-client/src/drive.ts";
import {createDriveAuthorization,GOOGLE_DRIVE_SCOPE,type GoogleDriveOAuth} from "../packages/auth/src/drive.ts";

const digest=async(blob:Blob)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await blob.arrayBuffer())),v=>v.toString(16).padStart(2,"0")).join("");
const marker="a".repeat(64),folderMarker="b".repeat(64),fileId="drive-file-1",folderId="drive-folder-1";
const response=(value:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json",...headers}});
function metadata(extra:Record<string,unknown>={}){return {id:fileId,name:"資料.txt",mimeType:"text/plain",size:"5",version:"1",modifiedTime:"2026-11-01T01:00:00Z",trashed:false,parents:[folderId],appProperties:{collectOriginal:marker},...extra};}
function client(fetcher:typeof fetch,extra:Partial<Parameters<typeof createDriveClient>[0]>={}){return createDriveClient({getAccessToken:()=>"private-token",fetch:fetcher,...extra});}
function oauthFixture(now=0){
  let config:Parameters<GoogleDriveOAuth["initTokenClient"]>[0]|undefined,requested=0,revoked="";
  const oauth:GoogleDriveOAuth={initTokenClient(value){config=value;return {requestAccessToken(){requested++;}};},revoke(token,done){revoked=token;done({successful:true});}};
  const auth=createDriveAuthorization({clientId:()=>"public.apps.googleusercontent.com",oauth:()=>oauth,now:()=>now});
  return {auth,oauth,config:()=>config!,requested:()=>requested,revoked:()=>revoked,setNow(value:number){now=value;}};
}

test("Drive OAuth requests only drive.file and keeps short-lived tokens bound to the active notebook",async()=>{
  const f=oauthFixture();const pending=f.auth.request("account:one:vault:1");
  assert.equal(f.requested(),1);assert.equal(f.config().scope,GOOGLE_DRIVE_SCOPE);assert.equal(f.config().include_granted_scopes,false);
  f.config().callback({access_token:"secret-access-token",expires_in:3600,scope:GOOGLE_DRIVE_SCOPE});await pending;
  assert.equal(f.auth.state().connected,true);assert.equal(f.auth.accessToken("account:one:vault:1"),"secret-access-token");
  assert.equal(JSON.stringify(f.auth.state()).includes("secret-access-token"),false);
  assert.throws(()=>f.auth.accessToken("account:two:vault:1"));
  f.setNow(3571000);assert.throws(()=>f.auth.accessToken("account:one:vault:1"));assert.equal(f.auth.state().connected,false);f.auth.clear();
});
test("Drive OAuth denies partial grants and ignores callbacks from a cleared vault",async()=>{
  const f=oauthFixture();const denied=f.auth.request("one");f.config().callback({access_token:"private-detail",expires_in:3600,scope:"openid"});
  await assert.rejects(denied,/アクセスが許可されません/);assert.equal(f.auth.state().connected,false);
  const cancelled=f.auth.request("one"),old=f.config();f.auth.clear();await assert.rejects(cancelled,/中断/);
  old.callback({access_token:"stale-token",expires_in:3600,scope:GOOGLE_DRIVE_SCOPE});assert.equal(f.auth.state().connected,false);assert.throws(()=>f.auth.accessToken("one"));
});
test("Drive disconnect clears memory before revoking authorization",async()=>{
  const f=oauthFixture();const ready=f.auth.request("one");f.config().callback({access_token:"token-to-revoke",expires_in:3600,scope:GOOGLE_DRIVE_SCOPE});await ready;
  await f.auth.disconnect();assert.equal(f.revoked(),"token-to-revoke");assert.equal(f.auth.state().connected,false);assert.throws(()=>f.auth.accessToken("one"));
});
test("Drive OAuth popup cancellation surfaces a fixed message without provider details",async()=>{
  const f=oauthFixture();const pending=f.auth.request("one");f.config().error_callback({type:"private-provider-detail"});
  await assert.rejects(pending,error=>error instanceof Error&&/中断/.test(error.message)&&!error.message.includes("private-provider-detail"));f.auth.clear();
});
test("Drive account identity and stable reserved IDs are fetched with constrained endpoints",async()=>{
  const calls:string[]=[];
  const api=client(async(url,init)=>{calls.push(String(url));assert.equal(new Headers(init?.headers).get("Authorization"),"Bearer private-token");assert.equal(init?.credentials,"omit");assert.equal(init?.redirect,"error");
    return String(url).includes("/about?")?response({user:{permissionId:"google-account-1",displayName:"利用者",emailAddress:"me@example.test"}}):response({ids:[fileId]});
  });
  assert.equal((await api.account()).permissionId,"google-account-1");assert.equal(await api.reserveFileId(),fileId);
  assert.equal(calls.every(url=>new URL(url).origin==="https://www.googleapis.com"),true);
  assert.notEqual(await driveUploadMarker("scope1","vault","item"),await driveUploadMarker("scope2","vault","item"));
});
test("Drive retry reuses the reserved ID and verifies existing original content",async()=>{
  const blob=new Blob(["hello"],{type:"text/plain"}),hash=await digest(blob);let calls=0;
  const api=client(async(url,init)=>{calls++;assert.equal(init?.method??"GET","GET");return response(metadata({sha256Checksum:hash}));});
  const file=await api.uploadFile({fileId,folderId,name:"資料.txt",mimeType:"text/plain",blob,marker});assert.equal(file.id,fileId);assert.equal(calls,1);
  const changed=client(async()=>response(metadata({sha256Checksum:"f".repeat(64)})));
  await assert.rejects(changed.uploadFile({fileId,folderId,name:"資料.txt",mimeType:"text/plain",blob,marker}),error=>error instanceof DriveError&&error.code==="upload_conflict");
});
test("Drive upload verifies downloaded content when Google omits its optional checksum",async()=>{
  const blob=new Blob(["hello"],{type:"text/plain"});let downloaded=0;
  const api=client(async url=>{if(String(url).includes("alt=media")){downloaded++;return new Response(blob);}return response(metadata());});
  await api.uploadFile({fileId,folderId,name:"資料.txt",mimeType:"text/plain",blob,marker});assert.equal(downloaded,1);
  const changed=client(async url=>String(url).includes("alt=media")?new Response("other"):response(metadata()));
  await assert.rejects(changed.uploadFile({fileId,folderId,name:"資料.txt",mimeType:"text/plain",blob,marker}),error=>error instanceof DriveError&&error.code==="upload_conflict");
});
test("Drive resumable upload probes acknowledged bytes after an interrupted chunk",async()=>{
  const blob=new Blob(["hello"],{type:"text/plain"}),hash=await digest(blob),ranges:string[]=[],progress:number[]=[];let first=true;
  const api=client(async(url,init)=>{
    if(String(url).includes("/drive/v3/files/"))return response({},404);
    if(init?.method==="POST"){const body=JSON.parse(String(init.body));assert.equal(body.id,fileId);assert.deepEqual(body.appProperties,{collectOriginal:marker});return response({},200,{Location:"https://www.googleapis.com/upload/drive/v3/files?upload_id=upload1"});}
    const range=new Headers(init?.headers).get("Content-Range")!;ranges.push(range);
    if(first){first=false;throw new Error("private-network-detail");}
    if(range==="bytes */5")return new Response(null,{status:308,headers:{Range:"bytes=0-1"}});
    assert.equal(await (init?.body as Blob).text(),"llo");return response(metadata({sha256Checksum:hash}));
  });
  await api.uploadFile({fileId,folderId,name:"資料.txt",mimeType:"text/plain",blob,marker,onProgress:sent=>progress.push(sent)});
  assert.deepEqual(ranges,["bytes 0-4/5","bytes */5","bytes 2-4/5"]);assert.equal(progress.at(-1),5);
});
test("Drive zero-byte files finalize via multipart upload and remain downloadable",async()=>{
  const empty=new Blob([],{type:"text/plain"}),hash=await digest(empty);let uploaded=false;
  const api=client(async(url,init)=>{
    if(String(url).includes("alt=media"))return new Response(null,{headers:{"Content-Length":"0"}});
    if(init?.method==="POST"){
      assert.equal(new URL(String(url)).searchParams.get("uploadType"),"multipart");assert.match(new Headers(init.headers).get("Content-Type")??"",/^multipart\/related;/);
      assert.match(await (init.body as Blob).text(),/"id":"drive-file-1"/);uploaded=true;return response(metadata({size:"0",sha256Checksum:hash}));
    }
    return uploaded?response(metadata({size:"0",sha256Checksum:hash})):response({},404);
  });
  assert.equal((await api.uploadFile({fileId,folderId,name:"empty.txt",mimeType:"text/plain",blob:empty,marker})).size,0);
  assert.equal((await api.downloadFile(fileId,{maxBytes:0})).blob.size,0);
});
test("Drive refuses a resumable Location outside Google's exact upload endpoint before sending credentials",async()=>{
  for(const location of ["https://evil.example/upload/drive/v3/files?upload_id=one","https://www.googleapis.com/other?upload_id=one","http://www.googleapis.com/upload/drive/v3/files?upload_id=one"]){
    let calls=0;const api=client(async(_url,init)=>{calls++;return init?.method==="POST"?response({},200,{Location:location}):response({},404);});
    await assert.rejects(api.uploadFile({fileId,folderId,name:"file.txt",mimeType:"text/plain",blob:new Blob(["hello"]),marker}),error=>error instanceof DriveError&&error.code==="invalid_response");assert.equal(calls,2);
  }
});
test("Drive folder listing excludes unregistered folders and creation retries cannot substitute another folder",async()=>{
  let listingQuery="";const folder=metadata({id:folderId,mimeType:"application/vnd.google-apps.folder",size:undefined,appProperties:{collectFolder:folderMarker}});
  const api=client(async(url,init)=>{
    if(init?.method==="POST")return response({},409);
    if(String(url).includes(`/files/${folderId}?`))return response(folder);
    listingQuery=new URL(String(url)).searchParams.get("q")??"";return response({files:[folder,metadata({id:"unregistered-folder",mimeType:"application/vnd.google-apps.folder",appProperties:{}})]});
  });
  assert.equal((await api.listFolders(folderMarker)).length,1);assert.match(listingQuery,/collectFolder/);assert.match(listingQuery,/mimeType=/);
  assert.equal((await api.createFolder({fileId:folderId,name:"Collect",scopeMarker:folderMarker})).id,folderId);
  const conflict=client(async(_url,init)=>init?.method==="POST"?response({},409):response({...folder,appProperties:{collectFolder:"f".repeat(64)}}));
  await assert.rejects(conflict.createFolder({fileId:folderId,name:"Collect",scopeMarker:folderMarker}),error=>error instanceof DriveError&&error.code==="upload_conflict");
});
test("Drive downloads check bounds, content hash, and a stable version before returning bytes",async()=>{
  const blob=new Blob(["hello"],{type:"text/plain"}),hash=await digest(blob);
  const api=client(async url=>String(url).includes("alt=media")?new Response(blob):response(metadata({sha256Checksum:hash})));
  const downloaded=await api.downloadFile(fileId,{maxBytes:5,expectedVersion:"1"});assert.equal(await downloaded.blob.text(),"hello");
  await assert.rejects(api.downloadFile(fileId,{maxBytes:4}),error=>error instanceof DriveError&&error.code==="invalid_response");
  let metadataReads=0;const changed=client(async url=>String(url).includes("alt=media")?new Response(blob):response(metadata({version:++metadataReads===1?"1":"2"})));
  await assert.rejects(changed.downloadFile(fileId,{maxBytes:5}),error=>error instanceof DriveError&&error.code==="upload_conflict");
  const oversized=client(async url=>String(url).includes("alt=media")?new Response("too much content"):response(metadata()));
  await assert.rejects(oversized.downloadFile(fileId,{maxBytes:5}),error=>error instanceof DriveError&&error.code==="invalid_response");
});
test("Drive unavailable/auth responses preserve a distinct state and do not reveal provider errors",async()=>{
  const missing=client(async()=>response({error:{message:"private-token"}},404));assert.equal(await missing.getFile(fileId),null);
  let expired=false;const api=client(async()=>response({error:{message:"private-token"}},401),{onUnauthorized:()=>{expired=true;}});
  await assert.rejects(api.getFile(fileId),error=>error instanceof DriveError&&error.code==="authorization"&&!error.message.includes("private-token"));assert.equal(expired,true);
  let active=true;const stale=client(async()=>{active=false;return response(metadata());},{isCurrent:()=>active});
  await assert.rejects(stale.getFile(fileId),error=>error instanceof DriveError&&error.code==="cancelled");
});
test("Drive metadata and original streams have bounded responses without trusting Content-Length",async()=>{
  const huge=client(async()=>new Response(" ".repeat(1024*1024+1)));
  await assert.rejects(huge.getFile(fileId),error=>error instanceof DriveError&&error.code==="invalid_response");
  const corruption=client(async url=>String(url).includes("alt=media")?new Response("other"):response(metadata({sha256Checksum:"a".repeat(64)})));
  await assert.rejects(corruption.downloadFile(fileId,{maxBytes:5}),error=>error instanceof DriveError&&error.code==="invalid_response");
});
