-- Generated with supabase@2.122.0 migration new suite_lifecycle.
begin;
alter table public.vault_keys add column retention_migrating boolean not null default false, add column retention_ready boolean not null default false;
alter table public.vault_records add column retention jsonb,add column purge_at timestamptz;
alter table public.vault_operations add column retention jsonb;
alter table public.vault_changes add column retention jsonb,add column purge jsonb;
alter table public.vault_changes alter column box drop not null;
alter table public.vault_archives add column refs_migrated boolean not null default false;
create index vault_records_due on public.vault_records(purge_at,owner_id) where purge_at is not null;
create index vault_relation_references on public.vault_records using gin((retention->'relatedIds')) where entity='relation';
create table public.vault_tombstones(owner_id uuid not null references public.vault_keys(owner_id) on delete cascade,entity text not null,entity_id text not null,revision bigint not null,purged_at timestamptz not null,primary key(owner_id,entity,entity_id));
create table public.vault_purge_receipts(owner_id uuid not null references public.vault_keys(owner_id) on delete cascade,id uuid not null,entity text not null,entity_id text not null,base_revision bigint,previous_id uuid,commitment text not null,retention jsonb,primary key(owner_id,id));
create table public.vault_file_links(owner_id uuid not null references public.vault_keys(owner_id) on delete cascade,entity text not null check(entity in ('resource','sketch')),entity_id text not null,path text not null,primary key(owner_id,entity,entity_id,path));
create index vault_file_links_path on public.vault_file_links(owner_id,path);
create table public.vault_file_gc(owner_id uuid not null references public.vault_keys(owner_id) on delete cascade,path text not null,eligible_at timestamptz not null,claim_token uuid,claimed_at timestamptz,completed_at timestamptz,attempts integer not null default 0,primary key(owner_id,path));
create index vault_file_gc_due on public.vault_file_gc(eligible_at) where completed_at is null;
create table public.vault_archive_refs(owner_id uuid not null,source text not null,page integer not null,entity_id text not null,primary key(owner_id,source,page,entity_id),foreign key(owner_id,source,page) references public.vault_archives(owner_id,source,page) on delete cascade);
create index vault_archive_refs_item on public.vault_archive_refs(owner_id,entity_id);
create table private.retention_worker_config(id boolean primary key default true check(id),token_hash text not null);
do $$declare t text;begin foreach t in array array['vault_tombstones','vault_purge_receipts','vault_file_links','vault_file_gc','vault_archive_refs'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('create policy owner_read on public.%I for select to authenticated using ((select auth.uid())=owner_id)',t);
 execute format('grant select on public.%I to authenticated',t);
end loop;end$$;

create function private.valid_retention(u uuid,e text,m jsonb) returns boolean language plpgsql stable set search_path='' as $$
declare path text;vid uuid;deadline timestamptz;
begin
 if jsonb_typeof(m) is distinct from 'object' or m->>'version' is distinct from '1' or jsonb_typeof(m->'spaceDeleted') is distinct from 'boolean' or jsonb_typeof(m->'relatedIds') is distinct from 'array' or jsonb_typeof(m->'filePaths') is distinct from 'array' then return false;end if;
 if jsonb_array_length(m->'filePaths')>20 or jsonb_array_length(m->'relatedIds')>1000 or exists(select 1 from jsonb_array_elements_text(m->'relatedIds') x where x !~ '^[A-Za-z0-9_-]{1,100}$') then return false;end if;
 if (m->>'spaceDeleted')::boolean and e<>'space' then return false;end if;
 if m->>'purgeAt' is not null then if e not in ('note','sketch','resource') then return false;end if;deadline:=(m->>'purgeAt')::timestamptz;if not isfinite(deadline) then return false;end if;end if;
 select vault_id into vid from public.vault_keys where owner_id=u;if vid is null then return false;end if;
 for path in select jsonb_array_elements_text(m->'filePaths') loop
  if e not in ('resource','sketch') or path !~ ('^'||u::text||'/'||vid::text||'/[A-Za-z0-9_-]{43}[.]bin$') then return false;end if;
 end loop;return true;
exception when others then return false;
end$$;
create function private.purge_notice(u uuid,e text,eid text) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('ownerId',owner_id,'entity',entity,'id',entity_id,'serverRevision',revision,'purgedAt',to_char(purged_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) from public.vault_tombstones where owner_id=u and entity=e and entity_id=eid
$$;
create function private.purge_vault_entity(u uuid,e text,eid text,p_time timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare rev bigint;c bigint;related text;paths text[];p text;notice jsonb;
begin
 perform 1 from public.vault_clocks where owner_id=u for update;if not found then raise exception 'Vault required';end if;
 notice:=private.purge_notice(u,e,eid);if notice is not null then return notice;end if;
 select coalesce(revision,0)+1 into rev from public.vault_records where owner_id=u and entity=e and entity_id=eid;rev:=coalesce(rev,1);
 insert into public.vault_tombstones values(u,e,eid,rev,p_time);
 insert into public.vault_purge_receipts select owner_id,id,entity,entity_id,base_revision,previous_id,commitment,retention from public.vault_operations where owner_id=u and entity=e and entity_id=eid on conflict do nothing;
 delete from public.vault_operations where owner_id=u and entity=e and entity_id=eid;
 delete from public.vault_changes where owner_id=u and entity=e and entity_id=eid;
 delete from public.vault_records where owner_id=u and entity=e and entity_id=eid;
 delete from public.vault_archives a where a.owner_id=u and exists(select 1 from public.vault_archive_refs r where r.owner_id=a.owner_id and r.source=a.source and r.page=a.page and r.entity_id=eid);
 select array_agg(path) into paths from public.vault_file_links where owner_id=u and entity=e and entity_id=eid;
 delete from public.vault_file_links where owner_id=u and entity=e and entity_id=eid;
 foreach p in array coalesce(paths,'{}'::text[]) loop
  if not exists(select 1 from public.vault_file_links where owner_id=u and path=p) then insert into public.vault_file_gc(owner_id,path,eligible_at) values(u,p,p_time+interval '10 minutes') on conflict do nothing;end if;
 end loop;
 notice:=private.purge_notice(u,e,eid);
 update public.vault_clocks set cursor=cursor+1 where owner_id=u returning cursor into c;
 insert into public.vault_changes(owner_id,cursor,entity,entity_id,revision,box,purge,retention) values(u,c,e,eid,rev,null,notice,'{}');
 if e in ('note','sketch','resource') then
  perform private.purge_vault_entity(u,'labels',eid,p_time);
  for related in select entity_id from public.vault_records where owner_id=u and entity='relation' and (retention->'relatedIds') ? eid loop perform private.purge_vault_entity(u,'relation',related,p_time);end loop;
 end if;return notice;
end$$;
create function private.expire_vault_records(p_owner uuid default null,p_time timestamptz default clock_timestamp()) returns integer language plpgsql security definer set search_path='' as $$
declare row record;n integer:=0;begin
 for row in select r.owner_id,r.entity,r.entity_id from public.vault_records r join public.vault_keys k on k.owner_id=r.owner_id where k.retention_ready and r.purge_at<=p_time and (p_owner is null or r.owner_id=p_owner) order by r.owner_id,r.purge_at limit 1000 loop
  perform 1 from public.vault_clocks where owner_id=row.owner_id for update;
  if exists(select 1 from public.vault_records where owner_id=row.owner_id and entity=row.entity and entity_id=row.entity_id and purge_at<=p_time) then perform private.purge_vault_entity(row.owner_id,row.entity,row.entity_id,p_time);n:=n+1;end if;
 end loop;return n;
end$$;

alter function private.push_vault_record(jsonb) rename to push_vault_record_v1;
create function private.push_vault_record(p_operation jsonb) returns jsonb language plpgsql security definer set search_path='' as $$begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode='42501';end if;
 if exists(select 1 from public.vault_keys where owner_id=auth.uid() and (retention_migrating or retention_ready)) then raise exception 'Refresh the application to use lifecycle sync' using errcode='42501';end if;
 return private.push_vault_record_v1(p_operation);
end$$;
create function private.add_vault_file_links(u uuid,e text,eid text,m jsonb) returns void language plpgsql security definer set search_path='' as $$
declare file_path text;begin for file_path in select jsonb_array_elements_text(m->'filePaths') loop
 if exists(select 1 from public.vault_file_gc where owner_id=u and path=file_path and (claim_token is not null or completed_at is not null)) then raise exception 'File retired' using errcode='22023';end if;
 insert into public.vault_file_links values(u,e,eid,file_path) on conflict do nothing;
 delete from public.vault_file_gc g where g.owner_id=u and g.path=file_path and g.claim_token is null and g.completed_at is null;
end loop;end$$;
create function private.push_vault_record_v2(p_operation jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid();e text:=p_operation->>'entity';eid text:=p_operation->>'entityId';op uuid:=(p_operation->>'id')::uuid;m jsonb:=p_operation->'retention';saved public.vault_operations;receipt public.vault_purge_receipts;outcome jsonb;notice jsonb;
begin
 if u is null then raise exception 'Authentication required' using errcode='42501';end if;
 perform 1 from public.vault_clocks where owner_id=u for update;if not found then raise exception 'Vault required';end if;
 if e is null or e not in ('note','space','sketch','resource','relation','project','labels') or eid is null or eid !~ '^[A-Za-z0-9_-]{1,100}$' or op is null or not private.valid_retention(u,e,m) or not private.check_vault_box(p_operation->'box') or p_operation->>'commitment' is null or p_operation->>'commitment' !~ '^[A-Za-z0-9+/]{43}=$' then raise exception 'Invalid lifecycle operation' using errcode='22023';end if;
 perform private.expire_vault_records(u);
 if exists(select 1 from public.vault_records where owner_id=u and entity=e and entity_id=eid and purge_at<=clock_timestamp()) and exists(select 1 from public.vault_keys where owner_id=u and retention_ready) then perform private.purge_vault_entity(u,e,eid,clock_timestamp());end if;
 select * into receipt from public.vault_purge_receipts where owner_id=u and id=op;
 if found and (receipt.entity<>e or receipt.entity_id<>eid or receipt.commitment is distinct from p_operation->>'commitment' or receipt.base_revision is distinct from (p_operation->>'baseRevision')::bigint or receipt.previous_id is distinct from (p_operation->>'previousOperationId')::uuid or receipt.retention is distinct from m) then raise exception 'Operation changed' using errcode='22023';end if;
 notice:=private.purge_notice(u,e,eid);if notice is not null then return jsonb_build_object('status','purged','operationId',op,'purged',notice);end if;
 select * into saved from public.vault_operations where owner_id=u and id=op;
 if found and saved.retention is distinct from m then raise exception 'Operation changed' using errcode='22023';end if;
 if (m->>'spaceDeleted')::boolean then
  notice:=private.purge_vault_entity(u,e,eid,clock_timestamp());
  insert into public.vault_purge_receipts values(u,op,e,eid,(p_operation->>'baseRevision')::bigint,(p_operation->>'previousOperationId')::uuid,p_operation->>'commitment',m) on conflict do nothing;
  return jsonb_build_object('status','purged','operationId',op,'purged',notice);
 end if;
 outcome:=private.push_vault_record_v1(p_operation);
 perform private.add_vault_file_links(u,e,eid,m);
 update public.vault_operations set retention=m where owner_id=u and id=op;
 if outcome->>'status'='applied' then
  update public.vault_records set retention=m,purge_at=(m->>'purgeAt')::timestamptz where owner_id=u and entity=e and entity_id=eid and revision=(outcome#>>'{record,revision}')::bigint;
  update public.vault_changes set retention=m where owner_id=u and entity=e and entity_id=eid and revision=(outcome#>>'{record,revision}')::bigint;
  outcome:=jsonb_set(outcome,'{record,retention}',m);
  update public.vault_operations set result=outcome where owner_id=u and id=op;
 else outcome:=jsonb_set(outcome,'{record,retention}',coalesce((select retention from public.vault_records where owner_id=u and entity=e and entity_id=eid),'null'::jsonb));end if;
 perform private.expire_vault_records(u);notice:=private.purge_notice(u,e,eid);
 if notice is not null then return jsonb_build_object('status','purged','operationId',op,'purged',notice);end if;
 return outcome;
end$$;
create function public.push_vault_record_v2(p_operation jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.push_vault_record_v2(p_operation)$$;
create function private.pull_vault_changes_v2(p_cursor text,p_limit integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid();changes jsonb;c bigint;
begin
 if u is null then raise exception 'Authentication required' using errcode='42501';end if;
 if p_cursor !~ '^[0-9]{1,19}$' or p_limit not between 1 and 100 then raise exception 'Invalid page';end if;
 perform private.expire_vault_records(u);
 select coalesce(jsonb_agg(jsonb_build_object('cursor',s.cursor::text,'entity',s.entity,'purged',s.purge,'record',case when s.purge is null then jsonb_build_object('entity',s.entity,'id',s.entity_id,'revision',s.revision,'box',s.box,'retention',s.retention) else null end) order by s.cursor),'[]'),coalesce(max(s.cursor),p_cursor::bigint) into changes,c from (select ch.* from public.vault_changes ch where ch.owner_id=u and ch.cursor>p_cursor::bigint and (ch.purge is not null or not exists(select 1 from public.vault_records r where r.owner_id=u and r.entity=ch.entity and r.entity_id=ch.entity_id and r.purge_at<=clock_timestamp() and exists(select 1 from public.vault_keys k where k.owner_id=u and k.retention_ready))) order by ch.cursor limit p_limit) s;
 return jsonb_build_object('changes',changes,'cursor',c::text,'hasMore',exists(select 1 from public.vault_changes where owner_id=u and cursor>c));
end$$;
create function public.pull_vault_changes_v2(p_cursor text,p_limit integer) returns jsonb language sql security invoker set search_path='' as $$select private.pull_vault_changes_v2(p_cursor,p_limit)$$;

-- Only a device holding the decryption key can index pre-existing ciphertext.
-- Expiry is armed after *all* heads, history, operation results and archives are indexed.
create function private.begin_vault_retention() returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid();ready boolean;begin
 if u is null then raise exception 'Authentication required' using errcode='42501';end if;
 perform 1 from public.vault_clocks where owner_id=u for update;
 select retention_ready into ready from public.vault_keys where owner_id=u and legacy_migrated;
 if ready is null then raise exception 'Complete encrypted migration first';end if;
 if not ready then update public.vault_keys set retention_migrating=true where owner_id=u;end if;
 return jsonb_build_object('ready',ready);
end$$;
create function public.begin_vault_retention() returns jsonb language sql security invoker set search_path='' as $$select private.begin_vault_retention()$$;
create function private.vault_retention_page(p_source text) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid();rows jsonb;begin
 if u is null then raise exception 'Authentication required' using errcode='42501';end if;
 if not exists(select 1 from public.vault_keys where owner_id=u and retention_migrating) then return '[]';end if;
 case p_source
 when 'records' then select coalesce(jsonb_agg(to_jsonb(s)),'[]') into rows from (select entity,entity_id as id,revision,box from public.vault_records where owner_id=u and retention is null order by entity,entity_id limit 5) s;
 when 'changes' then select coalesce(jsonb_agg(to_jsonb(s)),'[]') into rows from (select cursor::text as key,entity,entity_id as id,revision,box from public.vault_changes where owner_id=u and retention is null order by cursor limit 5) s;
 when 'operations' then select coalesce(jsonb_agg(to_jsonb(s)),'[]') into rows from (select id::text as key,entity,entity_id as id,box,result->'record' as canonical from public.vault_operations where owner_id=u and retention is null order by id limit 5) s;
 when 'archives' then select coalesce(jsonb_agg(to_jsonb(s)),'[]') into rows from (select source,page,box from public.vault_archives where owner_id=u and not refs_migrated order by source,page limit 5) s;
 else raise exception 'Invalid source';end case;return rows;
end$$;
create function public.vault_retention_page(p_source text) returns jsonb language sql security invoker set search_path='' as $$select private.vault_retention_page(p_source)$$;
create function private.index_vault_retention(p_source text,p_row jsonb) returns void language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid();e text:=p_row->>'entity';eid text:=p_row->>'id';m jsonb:=p_row->'retention';canonical jsonb:=p_row->'canonicalRetention';ref text;begin
 if u is null then raise exception 'Authentication required' using errcode='42501';end if;
 perform 1 from public.vault_clocks where owner_id=u for update;
 if not exists(select 1 from public.vault_keys where owner_id=u and retention_migrating) then return;end if;
 if p_source='archives' then
  if jsonb_typeof(p_row->'ids') is distinct from 'array' or jsonb_array_length(p_row->'ids')>1000 then raise exception 'Invalid references';end if;
  if not exists(select 1 from public.vault_archives where owner_id=u and source=p_row->>'source' and page=(p_row->>'page')::integer and box=p_row->'box') then raise exception 'Archive changed';end if;
  for ref in select jsonb_array_elements_text(p_row->'ids') loop
   if ref !~ '^[A-Za-z0-9_-]{1,100}$' then raise exception 'Invalid reference';end if;
   insert into public.vault_archive_refs values(u,p_row->>'source',(p_row->>'page')::integer,ref) on conflict do nothing;
  end loop;
  update public.vault_archives set refs_migrated=true where owner_id=u and source=p_row->>'source' and page=(p_row->>'page')::integer;
  delete from public.vault_archives a where a.owner_id=u and a.source=p_row->>'source' and a.page=(p_row->>'page')::integer and exists(select 1 from public.vault_archive_refs r join public.vault_tombstones t on t.owner_id=r.owner_id and t.entity_id=r.entity_id where r.owner_id=a.owner_id and r.source=a.source and r.page=a.page);return;
 end if;
 if eid is null or eid !~ '^[A-Za-z0-9_-]{1,100}$' or not private.valid_retention(u,e,m) then raise exception 'Invalid retention';end if;
 if p_source='records' then
  update public.vault_records set retention=m,purge_at=(m->>'purgeAt')::timestamptz where owner_id=u and entity=e and entity_id=eid and revision=(p_row->>'revision')::bigint and retention is null;
 elsif p_source='changes' then
  update public.vault_changes set retention=m where owner_id=u and cursor=(p_row->>'key')::bigint and entity=e and entity_id=eid and box=p_row->'box' and retention is null;
 elsif p_source='operations' then
  if not private.valid_retention(u,e,canonical) or p_row->>'commitment' is null or p_row->>'commitment' !~ '^[A-Za-z0-9+/]{43}=$' then raise exception 'Invalid operation metadata';end if;
  update public.vault_operations set retention=m,commitment=p_row->>'commitment',result=jsonb_set(result,'{record,retention}',canonical) where owner_id=u and id=(p_row->>'key')::uuid and entity=e and entity_id=eid and box=p_row->'box' and retention is null;
 else raise exception 'Invalid source';end if;
 if not found then return;end if;
 perform private.add_vault_file_links(u,e,eid,m);
 if p_source='operations' then perform private.add_vault_file_links(u,e,eid,canonical);end if;
end$$;
create function public.index_vault_retention(p_source text,p_row jsonb) returns void language sql security invoker set search_path='' as $$select private.index_vault_retention(p_source,p_row)$$;
create function private.finish_vault_retention() returns void language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid();begin
 if u is null then raise exception 'Authentication required' using errcode='42501';end if;
 perform 1 from public.vault_clocks where owner_id=u for update;
 if exists(select 1 from public.vault_records where owner_id=u and retention is null) or exists(select 1 from public.vault_changes where owner_id=u and retention is null) or exists(select 1 from public.vault_operations where owner_id=u and retention is null) or exists(select 1 from public.vault_archives where owner_id=u and not refs_migrated) then raise exception 'Retention index incomplete';end if;
 update public.vault_keys set retention_ready=true,retention_migrating=false where owner_id=u and legacy_migrated;
 if not found then raise exception 'Complete encrypted migration first';end if;
 perform private.expire_vault_records(u);
end$$;
create function public.finish_vault_retention() returns void language sql security invoker set search_path='' as $$select private.finish_vault_retention()$$;

create function private.register_vault_file(p_entity text,p_id text,p_path text) returns void language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid();m jsonb:=jsonb_build_object('version',1,'purgeAt',null,'spaceDeleted',false,'relatedIds','[]'::jsonb,'filePaths',jsonb_build_array(p_path));begin
 if u is null then raise exception 'Authentication required' using errcode='42501';end if;
 perform 1 from public.vault_clocks where owner_id=u for update;
 if p_entity is null or p_entity not in ('resource','sketch') or p_id is null or p_id !~ '^[A-Za-z0-9_-]{1,100}$' or not private.valid_retention(u,p_entity,m) then raise exception 'Invalid file reference';end if;
 perform private.expire_vault_records(u);
 if private.purge_notice(u,p_entity,p_id) is not null then raise exception 'Record permanently deleted';end if;
 perform private.add_vault_file_links(u,p_entity,p_id,m);
end$$;
create function public.register_vault_file(p_entity text,p_id text,p_path text) returns void language sql security invoker set search_path='' as $$select private.register_vault_file(p_entity,p_id,p_path)$$;
create function private.can_use_vault_file(p_path text) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.vault_keys k where k.owner_id=(select auth.uid()) and p_path ~ ('^'||k.owner_id::text||'/'||k.vault_id::text||'/[A-Za-z0-9_-]{43}[.]bin$') and (
 (not k.retention_migrating and not k.retention_ready) or (
 not exists(select 1 from public.vault_file_gc g where g.owner_id=k.owner_id and g.path=p_path and (g.claim_token is not null or g.completed_at is not null)) and
 exists(select 1 from public.vault_file_links l where l.owner_id=k.owner_id and l.path=p_path and not exists(select 1 from public.vault_tombstones t where t.owner_id=l.owner_id and t.entity=l.entity and t.entity_id=l.entity_id) and not exists(select 1 from public.vault_records r where r.owner_id=l.owner_id and r.entity=l.entity and r.entity_id=l.entity_id and k.retention_ready and r.purge_at<=clock_timestamp())))))
$$;
drop policy vault_blob_read on storage.objects;
drop policy vault_blob_insert on storage.objects;
create policy vault_blob_read on storage.objects for select to authenticated using(bucket_id='personal-tools-vault' and private.can_use_vault_file(name));
create policy vault_blob_insert on storage.objects for insert to authenticated with check(bucket_id='personal-tools-vault' and private.can_use_vault_file(name));

-- Worker access is service-role only; its separate scheduler token never reaches clients.
create function public.verify_retention_worker(p_token text) returns boolean language sql security definer set search_path='' as $$select coalesce(length(p_token)=64 and exists(select 1 from private.retention_worker_config where token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex')),false)$$;
create function public.claim_vault_file_gc(p_limit integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare row record;claimed jsonb:='[]';token uuid;begin
 if p_limit not between 1 and 100 then raise exception 'Invalid limit';end if;
 for row in select * from public.vault_file_gc where completed_at is null and eligible_at<=clock_timestamp() and (claimed_at is null or claimed_at<clock_timestamp()-interval '5 minutes') order by owner_id,path limit p_limit for update skip locked loop
  perform 1 from public.vault_clocks where owner_id=row.owner_id for update;
  if not exists(select 1 from public.vault_file_links where owner_id=row.owner_id and path=row.path) then
   token:=gen_random_uuid();update public.vault_file_gc set claim_token=token,claimed_at=clock_timestamp(),attempts=attempts+1 where owner_id=row.owner_id and path=row.path;
   claimed:=claimed||jsonb_build_array(jsonb_build_object('ownerId',row.owner_id,'path',row.path,'token',token));
  end if;
 end loop;return claimed;
end$$;
create function public.complete_vault_file_gc(p_owner uuid,p_path text,p_token uuid,p_success boolean) returns void language plpgsql security definer set search_path='' as $$begin
 update public.vault_file_gc set completed_at=case when p_success then clock_timestamp() else null end,claimed_at=case when p_success then claimed_at else null end,eligible_at=case when p_success then eligible_at else clock_timestamp()+interval '10 minutes' end where owner_id=p_owner and path=p_path and claim_token=p_token;
 -- Keep claim_token after failure: a file path cannot be reused while an old worker may still hold it.
end$$;
create function private.run_vault_retention() returns bigint language plpgsql security definer set search_path='' as $$
declare secret text;request_id bigint;begin
 perform private.expire_vault_records();
 select decrypted_secret into secret from vault.decrypted_secrets where name='personal-tools-retention-worker';
 if secret is null then raise exception 'Retention scheduler not configured';end if;
 select net.http_post(url:='https://zdixgamfhdgnqbgjckpj.supabase.co/functions/v1/vault-retention',headers:=jsonb_build_object('Content-Type','application/json','X-Retention-Token',secret),body:='{}',timeout_milliseconds:=10000) into request_id;
 return request_id;
end$$;

alter function private.store_vault_archive(text,integer,integer,jsonb) rename to store_vault_archive_v1;
create function private.store_vault_archive(p_source text,p_page integer,p_count integer,p_box jsonb) returns void language plpgsql security definer set search_path='' as $$begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode='42501';end if;
 perform 1 from public.vault_clocks where owner_id=auth.uid() for update;
 if exists(select 1 from public.vault_keys where owner_id=auth.uid() and (retention_migrating or retention_ready)) then raise exception 'Archive migration complete' using errcode='42501';end if;
 perform private.store_vault_archive_v1(p_source,p_page,p_count,p_box);
end$$;

-- Explicit ACLs: helpers never inherit PUBLIC execution privileges.
do $$declare f record;begin
 for f in select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='private' and (p.proname like '%vault%' or p.proname='valid_retention')) or (n.nspname='public' and p.proname in ('push_vault_record_v2','pull_vault_changes_v2','begin_vault_retention','vault_retention_page','index_vault_retention','finish_vault_retention','register_vault_file','verify_retention_worker','claim_vault_file_gc','complete_vault_file_gc')) loop
 execute format('revoke all on function %I.%I(%s) from public,anon,authenticated,service_role',f.nspname,f.proname,f.args);
 end loop;
end$$;
grant execute on function private.register_vault(jsonb),private.push_vault_record(jsonb),private.pull_vault_changes(text,integer),private.legacy_vault_page(text,integer),private.store_vault_archive(text,integer,integer,jsonb),private.finish_vault_migration() to authenticated;
grant execute on function private.push_vault_record_v2(jsonb),private.pull_vault_changes_v2(text,integer),private.begin_vault_retention(),private.vault_retention_page(text),private.index_vault_retention(text,jsonb),private.finish_vault_retention(),private.register_vault_file(text,text,text),private.can_use_vault_file(text) to authenticated;
grant execute on function public.push_vault_record_v2(jsonb),public.pull_vault_changes_v2(text,integer),public.begin_vault_retention(),public.vault_retention_page(text),public.index_vault_retention(text,jsonb),public.finish_vault_retention(),public.register_vault_file(text,text,text) to authenticated;
grant execute on function public.verify_retention_worker(text),public.claim_vault_file_gc(integer),public.complete_vault_file_gc(uuid,text,uuid,boolean) to service_role;
alter table private.retention_worker_config enable row level security;
revoke all on private.retention_worker_config from public,anon,authenticated,service_role;

-- PGlite tests exercise the same SQL without hosted-only extensions.
do $schedule$declare secret text;begin
 if exists(select 1 from pg_available_extensions where name='pg_cron') and exists(select 1 from pg_available_extensions where name='pg_net') and to_regnamespace('vault') is not null then
  create extension if not exists pg_cron;
  create extension if not exists pg_net;
  secret:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
  if not exists(select 1 from vault.decrypted_secrets where name='personal-tools-retention-worker') then perform vault.create_secret(secret,'personal-tools-retention-worker');end if;
  select decrypted_secret into secret from vault.decrypted_secrets where name='personal-tools-retention-worker';
  insert into private.retention_worker_config values(true,encode(sha256(convert_to(secret,'UTF8')),'hex')) on conflict(id) do update set token_hash=excluded.token_hash;
  perform cron.schedule('personal-tools-vault-retention','*/10 * * * *','select private.run_vault_retention();');
 end if;
end$schedule$;
commit;
