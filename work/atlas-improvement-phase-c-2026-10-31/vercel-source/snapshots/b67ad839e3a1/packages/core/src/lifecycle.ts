import type {SyncRecord} from "./index.ts";

export type VaultEntity="note"|"space"|"sketch"|"resource"|"relation"|"project"|"labels";
export type PurgeNotice={entity:VaultEntity;id:string;ownerId:string|null;serverRevision:number;purgedAt:string;cursor?:string;temporary?:boolean};
export const VAULT_ENTITIES:VaultEntity[]=["note","space","sketch","resource","relation","project","labels"];
export const TRASH_ENTITIES=["note","sketch","resource"] as const;

/** One calendar month in Japan, with an absent date clamped to month end.
 * Use UTC setters on a fixed +09:00 civil clock, independently of the device TZ. */
export function trashPurgeAt(deletedAt:string):string{
 const time=Date.parse(deletedAt);if(!Number.isFinite(time))throw new Error("削除日時を確認してください。");
 const civil=new Date(time+9*60*60*1000),day=civil.getUTCDate();civil.setUTCDate(1);civil.setUTCMonth(civil.getUTCMonth()+1);
 const last=new Date(Date.UTC(civil.getUTCFullYear(),civil.getUTCMonth()+1,0)).getUTCDate();civil.setUTCDate(Math.min(day,last));
 return new Date(civil.getTime()-9*60*60*1000).toISOString();
}
export function purgeDeadline(record:SyncRecord):string|null{
 return "kind" in record&&(TRASH_ENTITIES as readonly string[]).includes(record.kind)&&record.deletedAt?trashPurgeAt(record.deletedAt):null;
}
export function trashIsExpired(record:SyncRecord,now=Date.now()):boolean{const deadline=purgeDeadline(record);return !!deadline&&Date.parse(deadline)<=now;}
export function validatePurgeNotice(value:unknown,ownerId:string|null):PurgeNotice{
 const v=value as PurgeNotice;
 if(!v||!VAULT_ENTITIES.includes(v.entity)||typeof v.id!=="string"||!/^[-a-zA-Z0-9_]{1,100}$/.test(v.id)||v.ownerId!==ownerId||!Number.isSafeInteger(v.serverRevision)||v.serverRevision<0||typeof v.purgedAt!=="string"||!Number.isFinite(Date.parse(v.purgedAt)))throw new Error("削除通知を確認できません。");
 return {...v};
}
