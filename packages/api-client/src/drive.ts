import {MAX_RESOURCE_ORIGINAL_BYTES} from "@personal-tools/core";

/** Browser-only Drive adapter. File IDs are reserved and persisted before uploads.
 * https://developers.google.com/workspace/drive/api/guides/manage-uploads#pre-generated-id
 * https://developers.google.com/workspace/drive/api/guides/api-specific-auth */
export type DriveFile={id:string;name:string;mimeType:string;size:number;version:string;modifiedTime:string|null;trashed:boolean;parents:string[];appProperties:Record<string,string>;sha256Checksum:string|null};
export type DriveAccount={permissionId:string;displayName:string;emailAddress:string};
export type DriveUpload={fileId:string;folderId:string;name:string;mimeType:string;blob:Blob;marker:string;onProgress?:(sent:number,total:number)=>void};
export type DriveErrorCode="authorization"|"unavailable"|"network"|"invalid_response"|"upload_conflict"|"cancelled"|"quota";
export class DriveError extends Error {
  readonly code:DriveErrorCode;
  constructor(code:DriveErrorCode){
    const messages:Record<DriveErrorCode,string>={authorization:"Driveへの接続期限が切れました。もう一度接続してください。",unavailable:"Driveの原本を取得できません。削除やアクセス権を確認してください。",network:"Driveと通信できませんでした。通信状態を確認して再試行してください。",invalid_response:"Driveの応答を確認できませんでした。再試行してください。",upload_conflict:"Driveに別の内容の原本があります。上書きせずに保存を中止しました。",cancelled:"Driveの処理を中断しました。",quota:"Driveの空き容量または利用上限を確認してください。"};
    super(messages[code]);this.name="DriveError";this.code=code;
  }
}
const API="https://www.googleapis.com/drive/v3",UPLOAD="https://www.googleapis.com/upload/drive/v3/files";
const FIELDS="id,name,mimeType,size,version,modifiedTime,trashed,parents,appProperties,sha256Checksum";
const FOLDER="application/vnd.google-apps.folder",CHUNK=4*1024*1024,MAX_BYTES=MAX_RESOURCE_ORIGINAL_BYTES;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
function fileId(v:string){if(!/^[A-Za-z0-9_-]{1,200}$/.test(v))throw new DriveError("invalid_response");return v;}
function markerValue(v:string){if(!/^[a-f0-9]{64}$/.test(v))throw new DriveError("invalid_response");return v;}
function filename(v:string){if(!v.trim()||v.length>255||/[\u0000-\u001f]/.test(v))throw new DriveError("invalid_response");return v;}
function mediaType(v:string){if(!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(v)||v.startsWith("application/vnd.google-apps."))throw new DriveError("invalid_response");return v;}
function parseFile(v:unknown):DriveFile {
  if(!object(v)||typeof v.id!=="string"||typeof v.name!=="string"||typeof v.mimeType!=="string"||typeof v.version!=="string"||!/^\d{1,30}$/.test(v.version))throw new DriveError("invalid_response");
  const size=v.size===undefined?0:Number(v.size),modifiedTime=v.modifiedTime??null;
  if(!Number.isSafeInteger(size)||size<0||!(modifiedTime===null||typeof modifiedTime==="string"&&Number.isFinite(Date.parse(modifiedTime))))throw new DriveError("invalid_response");
  const props:Record<string,string>={};if(object(v.appProperties))for(const [k,x] of Object.entries(v.appProperties)){if(typeof x==="string")props[k]=x;}
  const parents=Array.isArray(v.parents)?v.parents.map(x=>{if(typeof x!=="string")throw new DriveError("invalid_response");return fileId(x);}):[];
  const checksum=typeof v.sha256Checksum==="string"&&/^[a-f0-9]{64}$/.test(v.sha256Checksum)?v.sha256Checksum:null;
  return {id:fileId(v.id),name:v.name,mimeType:v.mimeType,size,version:v.version,modifiedTime:modifiedTime as string|null,trashed:v.trashed===true,parents,appProperties:props,sha256Checksum:checksum};
}
/** Includes notebook/account context without putting private names into Drive metadata. */
export async function driveUploadMarker(scopeKey:string,vaultId:string,itemId:string):Promise<string>{
  const bytes=new TextEncoder().encode(JSON.stringify(["personal-tools.collect.v1",scopeKey,vaultId,itemId]));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),b=>b.toString(16).padStart(2,"0")).join("");
}
export function createDriveClient(options:{getAccessToken:()=>string;isCurrent?:()=>boolean;fetch?:typeof fetch;onUnauthorized?:()=>void;signal?:AbortSignal}){
  const fetcher=options.fetch??globalThis.fetch;
  function current(){if(options.signal?.aborted||options.isCurrent?.()===false)throw new DriveError("cancelled");}
  function endpoint(value:string,resumable=false){
    const u=new URL(value);
    if(u.protocol!=="https:"||u.origin!=="https://www.googleapis.com"||u.username||u.password||u.hash||!(resumable?u.pathname==="/upload/drive/v3/files"&&u.searchParams.has("upload_id"):u.pathname.startsWith("/drive/v3/")||u.pathname==="/upload/drive/v3/files"))throw new DriveError("invalid_response");
    return u.toString();
  }
  async function request(url:string,init:RequestInit={},resumable=false){
    current();const destination=endpoint(url,resumable),token=options.getAccessToken();
    if(!token||/[\r\n]/.test(token))throw new DriveError("authorization");
    let response:Response;
    const timeout=AbortSignal.timeout(60000),signal=options.signal?AbortSignal.any([options.signal,timeout]):timeout;
    try{response=await fetcher(destination,{...init,signal,headers:{...Object.fromEntries(new Headers(init.headers)),Authorization:`Bearer ${token}`},cache:"no-store",credentials:"omit",redirect:"error",referrerPolicy:"no-referrer"});}
    catch{current();throw new DriveError("network");}
    current();if(response.status===401){options.onUnauthorized?.();throw new DriveError("authorization");}return response;
  }
  async function json(response:Response):Promise<unknown>{
    const text=await (await boundedBlob(response,1024*1024,"application/json")).text();current();
    try{return JSON.parse(text);}catch{throw new DriveError("invalid_response");}
  }
  async function boundedBlob(response:Response,maxBytes:number,mimeType:string){
    const declared=response.headers.get("Content-Length");if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maxBytes)){await response.body?.cancel();throw new DriveError("invalid_response");}
    const chunks:Uint8Array<ArrayBuffer>[]=[],reader=response.body?.getReader();let size=0;
    if(!reader){if(maxBytes===0)return new Blob([],{type:mimeType});throw new DriveError("invalid_response");}
    try{while(true){current();const part=await reader.read();current();if(part.done)break;size+=part.value.byteLength;if(size>maxBytes)throw new DriveError("invalid_response");chunks.push(new Uint8Array(part.value));}}
    catch(error){await reader.cancel().catch(()=>{});if(error instanceof DriveError)throw error;throw new DriveError("network");}
    finally{reader.releaseLock();}
    return new Blob(chunks,{type:mimeType});
  }
  async function statusError(response:Response):Promise<never>{
    if(response.status===404||response.status===403)throw new DriveError("unavailable");
    if(response.status===429||response.status===507)throw new DriveError("quota");
    throw new DriveError(response.status>=500?"network":"invalid_response");
  }
  async function getFile(id:string):Promise<DriveFile|null>{
    const response=await request(`${API}/files/${fileId(id)}?${new URLSearchParams({fields:FIELDS})}`);
    if(response.status===403||response.status===404)return null;
    if(!response.ok)return statusError(response);const value=parseFile(await json(response));
    if(value.id!==id)throw new DriveError("invalid_response");return value;
  }
  async function verifyUpload(file:DriveFile,input:DriveUpload){
    if(file.id!==input.fileId||file.trashed||file.appProperties.collectOriginal!==input.marker||file.size!==input.blob.size||file.mimeType!==input.mimeType)throw new DriveError("upload_conflict");
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await input.blob.arrayBuffer())),b=>b.toString(16).padStart(2,"0")).join("");current();
    // Google computes this from the binary content, so an external same-size edit cannot be
    // mistaken for our original merely because it retained the app property.
    if(file.sha256Checksum){if(file.sha256Checksum!==hash)throw new DriveError("upload_conflict");}
    else{
      // The checksum is optional in the API; verify the actual bytes when Drive omits it.
      const response=await request(`${API}/files/${fileId(file.id)}?alt=media`);if(!response.ok)return statusError(response);
      const original=await boundedBlob(response,input.blob.size,file.mimeType),after=await getFile(file.id);
      const actual=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await original.arrayBuffer())),b=>b.toString(16).padStart(2,"0")).join("");current();
      if(!after||after.trashed||after.version!==file.version||actual!==hash)throw new DriveError("upload_conflict");
    }return file;
  }
  async function uploaded(input:DriveUpload){const found=await getFile(input.fileId);return found?verifyUpload(found,input):null;}
  /** A resumable URI is a credential. It is never returned or persisted outside this call.
   * https://developers.google.com/workspace/drive/api/guides/manage-uploads#resumable */
  async function uploadFile(input:DriveUpload):Promise<DriveFile>{
    fileId(input.fileId);fileId(input.folderId);filename(input.name);mediaType(input.mimeType);markerValue(input.marker);
    if(!(input.blob instanceof Blob)||input.blob.size>MAX_BYTES)throw new DriveError("invalid_response");
    const already=await uploaded(input);if(already){input.onProgress?.(input.blob.size,input.blob.size);return already;}
    const metadata={id:input.fileId,name:input.name,mimeType:input.mimeType,parents:[input.folderId],appProperties:{collectOriginal:input.marker}};
    if(input.blob.size===0){
      // A zero-length multipart media section creates an actual empty binary file. A
      // bytes */0 resumable PUT is only a status probe and need not finalize a file.
      // https://developers.google.com/workspace/drive/api/guides/manage-uploads#multipart
      const boundary=`collect_${crypto.randomUUID()}`;
      const body=new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${input.mimeType}\r\n\r\n`,input.blob,`\r\n--${boundary}--\r\n`]);
      const result=await request(`${UPLOAD}?${new URLSearchParams({uploadType:"multipart",fields:FIELDS})}`,{method:"POST",headers:{"Content-Type":`multipart/related; boundary=${boundary}`},body});
      if(result.status===409){const found=await uploaded(input);if(found)return found;throw new DriveError("upload_conflict");}
      if(!result.ok)return statusError(result);const file=await verifyUpload(parseFile(await json(result)),input);input.onProgress?.(0,0);return file;
    }
    const query=new URLSearchParams({uploadType:"resumable",fields:FIELDS});
    const start=await request(`${UPLOAD}?${query}`,{method:"POST",headers:{"Content-Type":"application/json; charset=UTF-8","X-Upload-Content-Type":input.mimeType,"X-Upload-Content-Length":String(input.blob.size)},body:JSON.stringify(metadata)});
    if(start.status===409){const found=await uploaded(input);if(found)return found;throw new DriveError("upload_conflict");}
    if(!start.ok)return statusError(start);
    const location=start.headers.get("Location");if(!location)throw new DriveError("invalid_response");const sessionUrl=endpoint(location,true);
    let offset=0,recoveries=0,stalls=0;input.onProgress?.(0,input.blob.size);
    const nextOffset=(response:Response)=>{
      const range=response.headers.get("Range");if(!range)return 0;
      const match=/^bytes=0-(\d+)$/.exec(range),value=match?Number(match[1])+1:NaN;
      if(!Number.isSafeInteger(value)||value<0||value>input.blob.size)throw new DriveError("invalid_response");return value;
    };
    while(offset<input.blob.size){
      current();const end=Math.min(offset+CHUNK,input.blob.size);let response:Response|undefined;
      try{response=await request(sessionUrl,{method:"PUT",headers:{"Content-Type":input.mimeType,"Content-Range":`bytes ${offset}-${end-1}/${input.blob.size}`},body:input.blob.slice(offset,end,input.mimeType)},true);}
      catch(error){if(!(error instanceof DriveError)||error.code!=="network")throw error;}
      if(response?.ok){const file=await verifyUpload(parseFile(await json(response)),input);input.onProgress?.(input.blob.size,input.blob.size);return file;}
      if(response?.status===308){const next=nextOffset(response);if(next<offset||next>end)throw new DriveError("invalid_response");if(next===offset&&++stalls>2)throw new DriveError("network");if(next>offset)stalls=0;offset=next;input.onProgress?.(offset,input.blob.size);continue;}
      if(response&&response.status<500&&response.status!==429){if(response.status===409){const found=await uploaded(input);if(found)return found;}return statusError(response);}
      if(++recoveries>3)throw new DriveError("network");
      // Probe acknowledged bytes after transport errors. Never assume a sent chunk was received.
      const probe=await request(sessionUrl,{method:"PUT",headers:{"Content-Range":`bytes */${input.blob.size}`}},true);
      if(probe.ok){const file=await verifyUpload(parseFile(await json(probe)),input);input.onProgress?.(input.blob.size,input.blob.size);return file;}
      if(probe.status!==308)return statusError(probe);const next=nextOffset(probe);if(next<offset)throw new DriveError("invalid_response");offset=next;input.onProgress?.(offset,input.blob.size);
    }
    const final=await uploaded(input);if(final)return final;throw new DriveError("network");
  }
  return {
    async account():Promise<DriveAccount>{
      // about.get accepts drive.file; permissionId binds pending uploads to the selected Google account.
      // https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get
      const response=await request(`${API}/about?${new URLSearchParams({fields:"user(permissionId,displayName,emailAddress)"})}`);
      if(!response.ok)return statusError(response);const v=await json(response);
      if(!object(v)||!object(v.user)||typeof v.user.permissionId!=="string"||!v.user.permissionId||v.user.permissionId.length>200)throw new DriveError("invalid_response");
      return {permissionId:v.user.permissionId,displayName:typeof v.user.displayName==="string"?v.user.displayName:"",emailAddress:typeof v.user.emailAddress==="string"?v.user.emailAddress:""};
    },
    async reserveFileId():Promise<string>{
      const response=await request(`${API}/files/generateIds?count=1&space=drive&type=files`);if(!response.ok)return statusError(response);
      const data=await json(response);if(!object(data)||!Array.isArray(data.ids)||typeof data.ids[0]!=="string")throw new DriveError("invalid_response");return fileId(data.ids[0]);
    },
    async listFolders(scopeMarker:string):Promise<DriveFile[]>{
      markerValue(scopeMarker);const result:DriveFile[]=[];let pageToken="",pages=0;
      do{
        const query=new URLSearchParams({q:`mimeType='${FOLDER}' and trashed=false and appProperties has { key='collectFolder' and value='${scopeMarker}' }`,fields:`nextPageToken,files(${FIELDS})`,pageSize:"100",spaces:"drive"});if(pageToken)query.set("pageToken",pageToken);
        const response=await request(`${API}/files?${query}`);if(!response.ok)return statusError(response);const data=await json(response);
        if(!object(data)||!Array.isArray(data.files)||data.nextPageToken!==undefined&&typeof data.nextPageToken!=="string")throw new DriveError("invalid_response");
        for(const v of data.files){const file=parseFile(v);if(file.mimeType!==FOLDER||file.trashed||file.appProperties.collectFolder!==scopeMarker)continue;result.push(file);}
        pageToken=typeof data.nextPageToken==="string"?data.nextPageToken:"";
        if(++pages>20||result.length>2000)throw new DriveError("invalid_response");
      }while(pageToken);return result;
    },
    async createFolder(input:{fileId:string;name:string;scopeMarker:string}):Promise<DriveFile>{
      fileId(input.fileId);filename(input.name);markerValue(input.scopeMarker);
      const response=await request(`${API}/files?${new URLSearchParams({fields:FIELDS})}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:input.fileId,name:input.name,mimeType:FOLDER,appProperties:{collectFolder:input.scopeMarker}})});
      if(response.status===409){const file=await getFile(input.fileId);if(file&&file.mimeType===FOLDER&&!file.trashed&&file.appProperties.collectFolder===input.scopeMarker)return file;throw new DriveError("upload_conflict");}
      if(!response.ok)return statusError(response);const file=parseFile(await json(response));if(file.id!==input.fileId||file.mimeType!==FOLDER||file.appProperties.collectFolder!==input.scopeMarker)throw new DriveError("invalid_response");return file;
    },
    getFile,uploadFile,
    async downloadFile(id:string,limits:{maxBytes:number;expectedVersion?:string}):Promise<{file:DriveFile;blob:Blob}>{
      if(!Number.isSafeInteger(limits.maxBytes)||limits.maxBytes<0||limits.maxBytes>MAX_BYTES)throw new DriveError("invalid_response");
      const file=await getFile(id);if(!file||file.trashed)throw new DriveError("unavailable");
      if(file.mimeType.startsWith("application/vnd.google-apps.")||file.size>limits.maxBytes)throw new DriveError("invalid_response");
      if(limits.expectedVersion&&file.version!==limits.expectedVersion)throw new DriveError("upload_conflict");
      const response=await request(`${API}/files/${fileId(id)}?alt=media`);if(!response.ok)return statusError(response);
      const blob=await boundedBlob(response,limits.maxBytes,file.mimeType);
      const after=await getFile(id);if(!after||after.trashed)throw new DriveError("unavailable");
      if(after.version!==file.version||blob.size!==file.size)throw new DriveError("upload_conflict");
      if(after.sha256Checksum){const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await blob.arrayBuffer())),b=>b.toString(16).padStart(2,"0")).join("");current();if(hash!==after.sha256Checksum)throw new DriveError("invalid_response");}
      return {file:after,blob};
    },
  };
}
