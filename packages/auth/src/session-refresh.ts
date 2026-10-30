export type SharedSessionRefreshBoundary={
  isBlocked():boolean;
  request():void;
  block():void;
  cancel():void;
  stop():void;
};

/** Browser namespace refresh only. It grants no server authorization.
 * Schedule SDK calls outside onAuthStateChange to avoid the SDK's auth lock.
 * https://supabase.com/docs/reference/javascript/auth-onauthstatechange
 */
export function createSharedSessionRefresh<Session>(options:{
  readLock:()=>string|null;
  readSession:()=>Promise<Session|null>;
  applySession:(session:Session|null)=>void;
  schedule:(work:()=>void)=>void;
}):SharedSessionRefreshBoundary {
  let blocked=options.readLock()==="1",stopped=false,revision=0;
  function isBlocked(){
    const stored=options.readLock();
    if(stored==="1")blocked=true;
    else if(stored==="0")blocked=false;
    // An absent/unavailable storage value never clears a prior offline logout.
    return blocked;
  }
  return {
    isBlocked,
    request(){
      if(stopped||isBlocked())return;
      const requestRevision=++revision;
      options.schedule(()=>{
        if(stopped||requestRevision!==revision||isBlocked())return;
        void (async()=>{
          let session:Session|null;
          try{session=await options.readSession();}catch{return;}
          if(!stopped&&requestRevision===revision&&!isBlocked())options.applySession(session);
        })();
      });
    },
    block(){blocked=true;revision++;},
    cancel(){revision++;},
    stop(){stopped=true;revision++;},
  };
}
