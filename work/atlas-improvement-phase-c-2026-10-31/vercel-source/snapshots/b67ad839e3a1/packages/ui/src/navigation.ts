export type DraftNavigationOptions={
  blocked:()=>boolean;
  prepare:()=>Promise<boolean>;
  commit:(href:string)=>void;
  failure:(error:unknown)=>void;
  pending?:(value:boolean)=>void;
};

/** Keep the page open until its latest draft has committed in the current scope. */
export function createDraftNavigation(options:DraftNavigationOptions){
  let pending=false;
  return async(href:string):Promise<boolean>=>{
    if(pending||options.blocked())return false;
    pending=true;options.pending?.(true);
    try{
      if(!await options.prepare()||options.blocked())return false;
      options.commit(href);return true;
    }catch(error){options.failure(error);return false;}
    finally{pending=false;options.pending?.(false);}
  };
}
