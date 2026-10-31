-- Generated with supabase@2.122.0 migration new phase4_collect.
-- Originals remain in private Storage; only bounded metadata enters the operation stream.
-- https://supabase.com/docs/guides/database/postgres/row-level-security
-- https://supabase.com/docs/guides/storage/security/access-control
begin;
create table public.resources(
  owner_id uuid not null,
  item_id uuid not null,
  resource_type text not null check(resource_type in ('link','image')),
  url text check(url is null or (length(url)<=8192 and url ~ '^https?://')),
  source_url text check(source_url is null or (length(source_url)<=8192 and source_url ~ '^https?://')),
  memo text not null default '' check(length(memo)<=100000),
  inbox boolean not null default true,
  image jsonb,
  metadata jsonb not null,
  primary key(owner_id,item_id),
  foreign key(owner_id,item_id) references public.items(owner_id,id) on delete cascade,
  check((resource_type='image' and image is not null) or (resource_type='link' and image is null and url is not null))
);
create index resources_by_image on public.resources(owner_id,(image->>'sha256')) where image is not null;
create index resources_by_url on public.resources(owner_id,url) where url is not null;
alter table public.resources enable row level security;
create policy owner_read on public.resources for select to authenticated using((select auth.uid())=owner_id);
revoke all on public.resources from public,anon,authenticated;
grant select on public.resources to authenticated;
alter table public.sync_operations drop constraint sync_operations_kind_check;
alter table public.sync_operations add constraint sync_operations_kind_check check(kind in ('put_note','put_space','put_sketch','put_relation','put_resource'));
alter table public.sync_changes drop constraint sync_changes_entity_check;
alter table public.sync_changes add constraint sync_changes_entity_check check(entity in ('note','space','sketch','relation','resource'));
alter table public.sync_conflicts drop constraint sync_conflicts_entity_check;
alter table public.sync_conflicts add constraint sync_conflicts_entity_check check(entity in ('note','space','sketch','relation','resource'));

create function private._sync_resource(p_owner uuid,p_id uuid)
returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',i.id,'kind','resource','originApp','collect','ownerId',i.owner_id,
   'resourceType',r.resource_type,'url',r.url,'sourceUrl',r.source_url,'title',i.title,'memo',r.memo,'inbox',r.inbox,
   'image',r.image,'metadata',r.metadata,
   'spaceIds',coalesce((select jsonb_agg(x.space_id order by x.space_id) from public.item_spaces x where x.owner_id=p_owner and x.item_id=p_id),'[]'::jsonb),
   'pinned',i.pinned,'createdAt',i.created_at,'updatedAt',i.updated_at,'deletedAt',i.deleted_at,'localRevision',1,'serverRevision',i.revision)
 from public.items i join public.resources r on r.owner_id=i.owner_id and r.item_id=i.id
 where i.owner_id=p_owner and i.id=p_id and i.kind='resource';
$$;
revoke all on function private._sync_resource(uuid,uuid) from public,anon,authenticated;
alter function private.apply_sync_operation(jsonb) rename to _apply_phase3_operation;
revoke all on function private._apply_phase3_operation(jsonb) from public,anon,authenticated;

create function private.apply_sync_operation(p_operation jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_owner uuid:=auth.uid();v_id uuid;v_entity_id uuid;v_payload jsonb;v_image jsonb;v_metadata jsonb;
 v_base bigint;v_previous uuid;v_existing public.sync_operations%rowtype;v_predecessor public.sync_operations%rowtype;
 v_record jsonb;v_result jsonb;v_revision bigint;v_cursor bigint;v_conflict uuid;v_space text;
 v_created timestamptz;v_deleted timestamptz;v_has_conflict boolean:=false;
begin
 if v_owner is null then raise exception 'Sign in required' using errcode='42501';end if;
 if p_operation->>'kind' in ('put_note','put_space','put_sketch','put_relation') then return private._apply_phase3_operation(p_operation);end if;
 if p_operation is null or jsonb_typeof(p_operation)<>'object' or octet_length(p_operation::text)>1048576
   or (p_operation->>'kind') is distinct from 'put_resource' then raise exception 'Invalid operation' using errcode='22023';end if;
 v_id:=(p_operation->>'id')::uuid;v_entity_id:=(p_operation->>'entityId')::uuid;v_payload:=p_operation->'payload';
 if v_id is null or v_entity_id is null or v_payload is null or jsonb_typeof(v_payload)<>'object'
   or (v_payload->>'id') is distinct from v_entity_id::text or (v_payload->>'kind') is distinct from 'resource'
   or (v_payload->>'originApp') is distinct from 'collect' then raise exception 'Invalid resource operation' using errcode='22023';end if;
 if not(p_operation ? 'baseRevision') or jsonb_typeof(p_operation->'baseRevision') not in ('null','number') then raise exception 'Invalid revision' using errcode='22023';end if;
 v_base:=(p_operation->>'baseRevision')::bigint;
 if v_base is not null and v_base not between 1 and 9007199254740991 then raise exception 'Invalid revision' using errcode='22023';end if;
 if v_base is not null and (p_operation->>'baseRevision')::numeric<>v_base then raise exception 'Invalid revision' using errcode='22023';end if;
 v_previous:=(p_operation->>'previousOperationId')::uuid;
 insert into public.sync_clocks(owner_id) values(v_owner) on conflict(owner_id) do nothing;
 perform 1 from public.sync_clocks where owner_id=v_owner for update;
 select * into v_existing from public.sync_operations where owner_id=v_owner and id=v_id;
 if found then
   if v_existing.operation is distinct from p_operation then raise exception 'Operation ID already used with different content' using errcode='22023';end if;
   return v_existing.result;
 end if;
 if v_previous is not null then
   select * into v_predecessor from public.sync_operations where owner_id=v_owner and id=v_previous;
   if not found or v_predecessor.kind<>'put_resource' or v_predecessor.entity_id<>v_entity_id::text then raise exception 'Previous operation not found for this entity' using errcode='22023';end if;
   if v_predecessor.result->>'status'='conflict' then v_has_conflict:=true;
   else v_base:=(v_predecessor.result->'record'->>'serverRevision')::bigint;end if;
 end if;
 if coalesce(v_payload->>'resourceType','') not in ('link','image') or jsonb_typeof(v_payload->'title') is distinct from 'string'
   or length(v_payload->>'title')>300 or jsonb_typeof(v_payload->'memo') is distinct from 'string' or length(v_payload->>'memo')>100000
   or jsonb_typeof(v_payload->'inbox') is distinct from 'boolean' or jsonb_typeof(v_payload->'pinned') is distinct from 'boolean'
   or jsonb_typeof(v_payload->'spaceIds') is distinct from 'array' or jsonb_array_length(v_payload->'spaceIds')>1000
   or jsonb_typeof(v_payload->'url') not in ('null','string') or not(v_payload ? 'url')
   or jsonb_typeof(v_payload->'sourceUrl') not in ('null','string') or not(v_payload ? 'sourceUrl') then raise exception 'Invalid resource' using errcode='22023';end if;
 if jsonb_typeof(v_payload->'createdAt') is distinct from 'string' or jsonb_typeof(v_payload->'updatedAt') is distinct from 'string'
   or not(v_payload ? 'deletedAt') or jsonb_typeof(v_payload->'deletedAt') not in ('null','string')
   or not(v_payload ? 'image') then raise exception 'Invalid resource dates or image' using errcode='22023';end if;
 if not isfinite((v_payload->>'createdAt')::timestamptz) or not isfinite((v_payload->>'updatedAt')::timestamptz)
   or (v_payload->>'deletedAt' is not null and not isfinite((v_payload->>'deletedAt')::timestamptz)) then raise exception 'Invalid resource dates' using errcode='22023';end if;
 if exists(select 1 from jsonb_array_elements(v_payload->'spaceIds') s where jsonb_typeof(s)<>'string') then raise exception 'Invalid space IDs' using errcode='22023';end if;
 if (v_payload->>'url') is not null and (length(v_payload->>'url')>8192 or (v_payload->>'url') !~ '^https?://[^[:space:]]+$')
   or (v_payload->>'sourceUrl') is not null and (length(v_payload->>'sourceUrl')>8192 or (v_payload->>'sourceUrl') !~ '^https?://[^[:space:]]+$') then raise exception 'Invalid resource URL' using errcode='22023';end if;
 v_image:=nullif(v_payload->'image','null'::jsonb);v_metadata:=v_payload->'metadata';
 if v_payload->>'resourceType'='image' then
   if v_image is null or jsonb_typeof(v_image)<>'object' or jsonb_typeof(v_image->'sha256') is distinct from 'string' or coalesce(v_image->>'sha256','') !~ '^[0-9a-f]{64}$'
     or coalesce(v_image->>'mimeType','') not in ('image/png','image/jpeg','image/gif','image/webp')
     or jsonb_typeof(v_image->'size') is distinct from 'number' or (v_image->>'size')::numeric not between 8 and 20971520
     or (v_image->>'size')::numeric<>trunc((v_image->>'size')::numeric)
     or jsonb_typeof(v_image->'filename') is distinct from 'string' or length(btrim(v_image->>'filename')) not between 1 and 255 then raise exception 'Invalid original image' using errcode='22023';end if;
 else
   if v_image is not null or (v_payload->>'url') is null then raise exception 'Invalid link resource' using errcode='22023';end if;
 end if;
 if v_metadata is null or jsonb_typeof(v_metadata)<>'object' or coalesce(v_metadata->>'status','') not in ('none','pending','ready','failed')
   or jsonb_typeof(v_metadata->'title') is distinct from 'string' or length(v_metadata->>'title')>300
   or jsonb_typeof(v_metadata->'description') is distinct from 'string' or length(v_metadata->>'description')>2000
   or not(v_metadata ? 'fetchedAt') or jsonb_typeof(v_metadata->'fetchedAt') not in ('null','string') then raise exception 'Invalid metadata' using errcode='22023';end if;
 if v_metadata->>'fetchedAt' is not null and not isfinite((v_metadata->>'fetchedAt')::timestamptz) then raise exception 'Invalid metadata date' using errcode='22023';end if;
 for v_space in select jsonb_array_elements_text(v_payload->'spaceIds') loop
   if not exists(select 1 from public.spaces where owner_id=v_owner and id=v_space) then raise exception 'Space not found in your account' using errcode='23503';end if;
 end loop;
 v_record:=private._sync_resource(v_owner,v_entity_id);
 if v_record is null and exists(select 1 from public.items where owner_id=v_owner and id=v_entity_id) then raise exception 'Item kind cannot change' using errcode='22023';end if;
 if v_record is not null and ((v_record->>'resourceType') is distinct from (v_payload->>'resourceType') or (v_record->'image') is distinct from (v_payload->'image')) then raise exception 'Original image cannot change' using errcode='22023';end if;
 v_revision:=(v_record->>'serverRevision')::bigint;v_has_conflict:=v_has_conflict or v_base is distinct from v_revision;
 if v_has_conflict then
   if v_record is null then raise exception 'Entity not found for revision' using errcode='22023';end if;
   v_conflict:=gen_random_uuid();
   insert into public.sync_conflicts(owner_id,id,operation_id,entity,entity_id,local_record,server_record) values(v_owner,v_conflict,v_id,'resource',v_entity_id::text,v_payload,v_record);
   v_result:=jsonb_build_object('status','conflict','operationId',v_id,'record',v_record,'conflictId',v_conflict);
 else
   v_revision:=coalesce(v_revision,0)+1;v_created:=coalesce((v_record->>'createdAt')::timestamptz,(v_payload->>'createdAt')::timestamptz,now());v_deleted:=(v_payload->>'deletedAt')::timestamptz;
   insert into public.items(owner_id,id,kind,origin_app,title,pinned,created_at,updated_at,deleted_at,revision)
     values(v_owner,v_entity_id,'resource','collect',btrim(v_payload->>'title'),(v_payload->>'pinned')::boolean,v_created,clock_timestamp(),v_deleted,v_revision)
     on conflict(owner_id,id) do update set title=excluded.title,pinned=excluded.pinned,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at,revision=excluded.revision;
   insert into public.resources(owner_id,item_id,resource_type,url,source_url,memo,inbox,image,metadata)
     values(v_owner,v_entity_id,v_payload->>'resourceType',v_payload->>'url',v_payload->>'sourceUrl',v_payload->>'memo',(v_payload->>'inbox')::boolean,v_image,v_metadata)
     on conflict(owner_id,item_id) do update set url=excluded.url,source_url=excluded.source_url,memo=excluded.memo,inbox=excluded.inbox,metadata=excluded.metadata;
   delete from public.item_spaces where owner_id=v_owner and item_id=v_entity_id;
   insert into public.item_spaces(owner_id,item_id,space_id) select distinct v_owner,v_entity_id,jsonb_array_elements_text(v_payload->'spaceIds');
   v_record:=private._sync_resource(v_owner,v_entity_id);
   update public.sync_clocks set cursor=cursor+1 where owner_id=v_owner returning cursor into v_cursor;
   insert into public.sync_changes(owner_id,cursor,entity,entity_id,record) values(v_owner,v_cursor,'resource',v_entity_id::text,v_record);
   v_result:=jsonb_build_object('status','applied','operationId',v_id,'record',v_record);
 end if;
 insert into public.sync_operations(owner_id,id,kind,entity_id,operation,result) values(v_owner,v_id,'put_resource',v_entity_id::text,p_operation,v_result);
 return v_result;
end;
$$;
revoke all on function private.apply_sync_operation(jsonb) from public,anon,authenticated;
grant execute on function private.apply_sync_operation(jsonb) to authenticated;

-- v3 clients cannot parse resource rows. Preserve their contract during independent rollout.
alter function private.pull_suite_changes(text,integer) rename to pull_tools_changes;
revoke all on function private.pull_tools_changes(text,integer) from public,anon,authenticated;
create function private.pull_suite_changes(p_cursor text default '0',p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();v_after bigint;v_next bigint;v_limit integer;v_changes jsonb;
begin
 if v_owner is null then raise exception 'Sign in required' using errcode='42501';end if;
 if p_cursor is null or p_cursor !~ '^[0-9]{1,19}$' then raise exception 'Invalid cursor' using errcode='22023';end if;
 v_after:=p_cursor::bigint;v_limit:=least(greatest(coalesce(p_limit,100),1),200);
 select coalesce(jsonb_agg(jsonb_build_object('cursor',c.cursor::text,'entity',c.entity,'record',c.record) order by c.cursor),'[]'::jsonb),coalesce(max(c.cursor),v_after)
 into v_changes,v_next from(select * from public.sync_changes where owner_id=v_owner and cursor>v_after and entity<>'resource' order by cursor limit v_limit)c;
 return jsonb_build_object('changes',v_changes,'cursor',v_next::text,'hasMore',exists(select 1 from public.sync_changes where owner_id=v_owner and cursor>v_next and entity<>'resource'));
end;
$$;
revoke all on function private.pull_suite_changes(text,integer) from public,anon,authenticated;
create function public.pull_tools_changes(p_cursor text default '0',p_limit integer default 100)
returns jsonb language sql stable security invoker set search_path='' as $$select private.pull_tools_changes(p_cursor,p_limit);$$;
revoke all on function public.pull_tools_changes(text,integer) from public,anon,authenticated;
grant execute on function private.pull_suite_changes(text,integer),private.pull_tools_changes(text,integer),public.pull_tools_changes(text,integer) to authenticated;

create function private._resource_original_path(p_owner uuid,p_id uuid,p_image jsonb)
returns text language sql immutable set search_path='' as $$
 select p_owner::text||'/'||p_id::text||'/originals/'||(p_image->>'sha256')||'.'||
  case p_image->>'mimeType' when 'image/png' then 'png' when 'image/jpeg' then 'jpg' when 'image/gif' then 'gif' when 'image/webp' then 'webp' end;
$$;
revoke all on function private._resource_original_path(uuid,uuid,jsonb) from public,anon,authenticated;
create function private.register_resource_original(p_item_id uuid,p_path text,p_sha256 text,p_mime text,p_size integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();v_image jsonb;v_revision bigint;v_id uuid;
begin
 if v_owner is null then raise exception 'Sign in required' using errcode='42501';end if;
 select r.image,i.revision into v_image,v_revision from public.resources r join public.items i on i.owner_id=r.owner_id and i.id=r.item_id
   where r.owner_id=v_owner and r.item_id=p_item_id and r.resource_type='image' and i.deleted_at is null for share of i;
 if not found then raise exception 'Image resource not found' using errcode='22023';end if;
 if p_path is distinct from private._resource_original_path(v_owner,p_item_id,v_image) or p_sha256 is distinct from (v_image->>'sha256')
   or p_mime is distinct from (v_image->>'mimeType') or p_size is distinct from (v_image->>'size')::integer then raise exception 'Original image changed' using errcode='22023';end if;
 if not exists(select 1 from storage.objects where bucket_id='personal-tools-private' and name=p_path
   and metadata->>'size'=p_size::text and metadata->>'mimetype'=p_mime) then raise exception 'Original upload not found' using errcode='22023';end if;
 insert into public.assets(owner_id,item_id,storage_path,mime_type,size_bytes,source_revision) values(v_owner,p_item_id,p_path,p_mime,p_size,v_revision)
   on conflict(storage_path) do update set source_revision=excluded.source_revision returning id into v_id;
 return jsonb_build_object('id',v_id,'path',p_path,'sha256',p_sha256);
end;
$$;
create function public.register_resource_original(p_item_id uuid,p_path text,p_sha256 text,p_mime text,p_size integer)
returns jsonb language sql volatile security invoker set search_path='' as $$select private.register_resource_original(p_item_id,p_path,p_sha256,p_mime,p_size);$$;
create function private.get_resource_original(p_item_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();v_image jsonb;v_path text;
begin
 if v_owner is null then raise exception 'Sign in required' using errcode='42501';end if;
 select image into v_image from public.resources where owner_id=v_owner and item_id=p_item_id and resource_type='image';
 if not found then raise exception 'Image resource not found' using errcode='22023';end if;
 v_path:=private._resource_original_path(v_owner,p_item_id,v_image);
 if not exists(select 1 from storage.objects where bucket_id='personal-tools-private' and name=v_path
   and metadata->>'size'=v_image->>'size' and metadata->>'mimetype'=v_image->>'mimeType') then return null;end if;
 return jsonb_build_object('path',v_path,'sha256',v_image->>'sha256','mimeType',v_image->>'mimeType','size',(v_image->>'size')::integer,
   'registered',exists(select 1 from public.assets where owner_id=v_owner and item_id=p_item_id and storage_path=v_path));
end;
$$;
create function public.get_resource_original(p_item_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$select private.get_resource_original(p_item_id);$$;
revoke all on function private.register_resource_original(uuid,text,text,text,integer),public.register_resource_original(uuid,text,text,text,integer),private.get_resource_original(uuid),public.get_resource_original(uuid) from public,anon,authenticated;
grant execute on function private.register_resource_original(uuid,text,text,text,integer),public.register_resource_original(uuid,text,text,text,integer),private.get_resource_original(uuid),public.get_resource_original(uuid) to authenticated;

-- Originals are immutable even through the direct Storage API. Trash/restore keeps them.
alter policy personal_tools_private_update on storage.objects using(
 bucket_id='personal-tools-private' and (storage.foldername(name))[1]=(select auth.uid())::text
 and (storage.foldername(name))[3] is distinct from 'originals'
 and exists(select 1 from public.items i where i.owner_id=(select auth.uid()) and i.id::text=(storage.foldername(name))[2])
)with check(
 bucket_id='personal-tools-private' and (storage.foldername(name))[1]=(select auth.uid())::text
 and (storage.foldername(name))[3] is distinct from 'originals'
 and exists(select 1 from public.items i where i.owner_id=(select auth.uid()) and i.id::text=(storage.foldername(name))[2])
);
alter policy personal_tools_private_delete on storage.objects using(
 bucket_id='personal-tools-private' and (storage.foldername(name))[1]=(select auth.uid())::text
 and (storage.foldername(name))[3] is distinct from 'originals'
 and exists(select 1 from public.items i where i.owner_id=(select auth.uid()) and i.id::text=(storage.foldername(name))[2])
);
commit;
