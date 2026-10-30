// Real PostgreSQL in WASM; only Supabase-owned auth/storage scaffolding is stubbed.
// API source: https://pglite.dev/docs/api (exec/query/transaction).
import {PGlite} from "@electric-sql/pglite";
import {readFile,readdir} from "node:fs/promises";

export const USER_A="11111111-1111-4111-8111-111111111111";
export const USER_B="22222222-2222-4222-8222-222222222222";
type Queryable=Pick<PGlite,"query"|"exec">;

export async function createTestDatabase() {
  const db=await PGlite.create();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to anon,authenticated;
    grant execute on function auth.uid() to anon,authenticated;
    create schema storage;
    create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,owner_id text);
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql immutable as
      $$ select (string_to_array(name,'/'))[1:greatest(array_length(string_to_array(name,'/'),1)-1,0)] $$;
    grant usage on schema storage to anon,authenticated;
    grant execute on function storage.foldername(text) to anon,authenticated;
    grant select,insert,update,delete on storage.objects to authenticated;
    insert into auth.users(id) values('${USER_A}'),('${USER_B}');
  `);
  const migrationDirectory=new URL("../../supabase/migrations/",import.meta.url);
  for(const filename of (await readdir(migrationDirectory)).filter(name=>name.endsWith(".sql")).sort()) {
    await db.exec(await readFile(new URL(filename,migrationDirectory),"utf8"));
  }

  const asUser=async<T>(userId:string|null,work:(tx:Queryable)=>Promise<T>):Promise<T>=>db.transaction(async tx=>{
    await tx.exec(`set local role ${userId?"authenticated":"anon"}`);
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[userId??""]);
    return work(tx);
  });
  const queryAs=async(userId:string|null,sql:string,params:unknown[]=[])=>asUser(userId,tx=>tx.query(sql,params));
  return {
    db,asUser,queryAs,
    async addUser(userId=crypto.randomUUID()) {await db.query("insert into auth.users(id) values($1) on conflict do nothing",[userId]);return userId;},
    async apply(userId:string,operation:unknown) {
      const result=await queryAs(userId,"select public.apply_sync_operation($1::jsonb) as result",[JSON.stringify(operation)]);
      return result.rows[0].result as {status:"applied"|"conflict";operationId:string;record:Record<string,unknown>;conflictId?:string};
    },
    async pull(userId:string,cursor="0",limit=100) {
      const result=await queryAs(userId,"select public.pull_sync_changes($1,$2) as result",[cursor,limit]);
      return result.rows[0].result as {changes:{cursor:string;entity:"note"|"space";record:Record<string,unknown>}[];cursor:string;hasMore:boolean};
    },
    async pullSuite(userId:string,cursor="0",limit=100) {
      const result=await queryAs(userId,"select public.pull_suite_changes($1,$2) as result",[cursor,limit]);
      return result.rows[0].result as {changes:{cursor:string;entity:"note"|"space"|"sketch"|"relation";record:Record<string,unknown>}[];cursor:string;hasMore:boolean};
    },
    close:()=>db.close(),
  };
}
