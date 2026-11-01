import {subscribeVault,vaultSession} from "@personal-tools/api-client";

export const GOOGLE_DRIVE_SCOPE="https://www.googleapis.com/auth/drive.file";
type TokenResponse={access_token?:string;expires_in?:number|string;scope?:string;error?:string};
export type GoogleDriveOAuth={initTokenClient(config:{client_id:string;scope:string;include_granted_scopes:boolean;callback:(response:TokenResponse)=>void;error_callback:(error:{type:string})=>void}):{requestAccessToken(config?:{prompt?:string}):void};revoke(token:string,callback:(response:{successful?:boolean;error?:string})=>void):void};
export type DriveAuthorizationState={configured:boolean;loaded:boolean;connected:boolean;busy:boolean;expiresAt:number|null;scopeKey:string|null;error:string};
const LIBRARY="https://accounts.google.com/gsi/client";
let libraryPromise:Promise<void>|null=null;
function googleOAuth():GoogleDriveOAuth|undefined{return (globalThis as typeof globalThis&{google?:{accounts?:{oauth2?:GoogleDriveOAuth}}}).google?.accounts?.oauth2;}
export function getGoogleDriveClientId():string|null {
  // Public client ID only. A dedicated OAuth client keeps Drive revocation separate from app login.
  const id=process.env.NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID?.trim();
  return id&&/^[a-zA-Z0-9_.-]+\.apps\.googleusercontent\.com$/.test(id)?id:null;
}
/** Loaded only when the user opens Drive settings. Never bundled or service-worker cached.
 * https://developers.google.com/identity/oauth2/web/guides/load-3p-authorization-library */
export async function loadDriveAuthorization():Promise<void>{
  if(!getGoogleDriveClientId())throw new Error("Drive接続の設定がまだありません。");
  if(googleOAuth()){authorization.libraryLoaded();return;}
  if(typeof document==="undefined")throw new Error("ブラウザでDriveに接続してください。");
  if(!libraryPromise)libraryPromise=new Promise<void>((resolve,reject)=>{
    const script=document.createElement("script");script.src=LIBRARY;script.async=true;script.referrerPolicy="no-referrer";
    const timer=setTimeout(()=>finish(false),15000);
    const finish=(ok:boolean)=>{clearTimeout(timer);script.onload=null;script.onerror=null;if(ok&&googleOAuth()){authorization.libraryLoaded();resolve();}else{script.remove();libraryPromise=null;reject(new Error("Drive接続の準備ができませんでした。通信状態を確認して再試行してください。"));}};
    script.onload=()=>finish(true);script.onerror=()=>finish(false);document.head.appendChild(script);
  });
  return libraryPromise;
}

/** Browser token model: no refresh token or provider token is stored in browser storage.
 * https://developers.google.com/identity/oauth2/web/guides/use-token-model */
export function createDriveAuthorization(options:{clientId:()=>string|null;oauth:()=>GoogleDriveOAuth|undefined;now?:()=>number}){
  const now=options.now??Date.now,listeners=new Set<()=>void>();
  let token:string|null=null,expiresAt:number|null=null,scopeKey:string|null=null,busy=false,error="",loaded=false,generation=0;
  let expiryTimer:ReturnType<typeof setTimeout>|undefined;
  let pending:{cancel:()=>void}|null=null;
  const emit=()=>{for(const listener of listeners)listener();};
  function clear(){
    generation++;token=null;expiresAt=null;scopeKey=null;busy=false;error="";clearTimeout(expiryTimer);expiryTimer=undefined;
    const request=pending;pending=null;request?.cancel();emit();
  }
  function expire(){if(expiresAt!==null&&now()>=expiresAt){clear();return true;}return false;}
  return {
    libraryLoaded(){loaded=true;emit();},
    state():DriveAuthorizationState {
      // Reading state never exposes the credential itself.
      const expired=expiresAt!==null&&now()>=expiresAt;
      return {configured:!!options.clientId(),loaded:loaded||!!options.oauth(),connected:!!token&&!expired,busy,expiresAt:expired?null:expiresAt,scopeKey:expired?null:scopeKey,error};
    },
    subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
    accessToken(expectedScopeKey:string):string {
      expire();if(!token||scopeKey!==expectedScopeKey){throw new Error("Driveにもう一度接続してください。");}return token;
    },
    clear,
    request(expectedScopeKey:string):Promise<void>{
      if(!expectedScopeKey||expectedScopeKey.length>1000)return Promise.reject(new Error("Driveの保存先を確認してください。"));
      if(busy)return Promise.reject(new Error("Driveへの接続を待っています。"));
      const clientId=options.clientId(),oauth=options.oauth();
      if(!clientId)return Promise.reject(new Error("Drive接続の設定がまだありません。"));
      if(!oauth)return Promise.reject(new Error("Drive接続の準備中です。準備ができてからもう一度押してください。"));
      clear();busy=true;loaded=true;error="";scopeKey=expectedScopeKey;const requestGeneration=generation;emit();
      return new Promise<void>((resolve,reject)=>{
        let settled=false;const timeout=setTimeout(()=>finish(new Error("Driveへの接続を完了できませんでした。もう一度接続してください。")),120000);
        function finish(failure?:Error){
          if(settled)return;settled=true;clearTimeout(timeout);pending=null;
          if(requestGeneration===generation){busy=false;if(failure){token=null;expiresAt=null;error=failure.message;}emit();}
          if(failure)reject(failure);else resolve();
        }
        pending={cancel:()=>finish(new Error("Driveへの接続を中断しました。"))};
        try{
          const client=oauth.initTokenClient({client_id:clientId,scope:GOOGLE_DRIVE_SCOPE,include_granted_scopes:false,
            callback:response=>{
              if(requestGeneration!==generation||settled)return;
              const seconds=Number(response.expires_in),granted=new Set(response.scope?.split(/\s+/));
              if(response.error||!response.access_token||/[\r\n]/.test(response.access_token)||!granted.has(GOOGLE_DRIVE_SCOPE)||!Number.isFinite(seconds)||seconds<=30||seconds>86400){finish(new Error("Driveへのアクセスが許可されませんでした。もう一度接続してください。"));return;}
              token=response.access_token;expiresAt=now()+(seconds-30)*1000;scopeKey=expectedScopeKey;
              expiryTimer=setTimeout(()=>{expire();},(seconds-30)*1000);finish();
            },
            error_callback:()=>finish(new Error("Driveへの接続を中断しました。もう一度接続してください。")),
          });
          // Keep this synchronous with the user's click; popups after an await can be blocked.
          client.requestAccessToken({prompt:"select_account"});
        }catch{finish(new Error("Driveへの接続を開始できませんでした。もう一度接続してください。"));}
      });
    },
    async disconnect(){
      const old=token,oauth=options.oauth();clear();if(!old||!oauth)return;
      await new Promise<void>((resolve,reject)=>{
        let settled=false;const finish=(ok:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);if(ok)resolve();else reject(new Error("端末の接続は解除しました。Google側の権限解除はGoogleアカウントの接続設定で確認してください。"));};
        const timer=setTimeout(()=>finish(false),10000);
        try{oauth.revoke(old,result=>finish(result.successful===true||result.error==="invalid_token"));}catch{finish(false);}
      });
    },
  };
}
const authorization=createDriveAuthorization({clientId:getGoogleDriveClientId,oauth:googleOAuth});
// Locking or changing the active vault invalidates outstanding OAuth callbacks and in-memory tokens.
let vaultIdentity=vaultSession();
subscribeVault(()=>{const next=vaultSession();if(next!==vaultIdentity){vaultIdentity=next;authorization.clear();}});
export const requestDriveAccess=(scopeKey:string)=>authorization.request(scopeKey);
export const driveAccessToken=(scopeKey:string)=>authorization.accessToken(scopeKey);
export const clearDriveAuthorization=()=>authorization.clear();
export const disconnectDrive=()=>authorization.disconnect();
export const subscribeDriveAuthorization=(listener:()=>void)=>authorization.subscribe(listener);
export const getDriveAuthorizationState=()=>authorization.state();
