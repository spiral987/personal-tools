-- Apply once to a new Supabase development project, as postgres (SQL editor or CLI).
-- RLS patterns: https://supabase.com/docs/guides/database/postgres/row-level-security
-- Function privileges/search_path: https://supabase.com/docs/guides/database/functions
-- Storage policies: https://supabase.com/docs/guides/storage/security/access-control
begin;

create table public.items (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  kind text not null check (kind in ('note','sketch','resource')),
  origin_app text not null,
  title text not null default '',
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  revision bigint not null default 1 check (revision between 1 and 9007199254740991),
  primary key (owner_id,id)
);
create index items_owner_recent on public.items(owner_id,deleted_at,created_at desc,id);

create table public.notes (
  owner_id uuid not null,
  item_id uuid not null,
  body text not null check (length(btrim(body)) between 1 and 100000),
  primary key (owner_id,item_id),
  foreign key (owner_id,item_id) references public.items(owner_id,id) on delete cascade
);
create table public.spaces (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id text not null check (id ~ '^[A-Za-z0-9_-]{1,100}$'),
  name text not null check (length(btrim(name)) between 1 and 40),
  color text not null check (color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at timestamptz not null default now(),
  revision bigint not null default 1 check (revision between 1 and 9007199254740991),
  primary key(owner_id,id)
);
create table public.item_spaces (
  owner_id uuid not null,
  item_id uuid not null,
  space_id text not null,
  primary key(owner_id,item_id,space_id),
  foreign key(owner_id,item_id) references public.items(owner_id,id) on delete cascade,
  foreign key(owner_id,space_id) references public.spaces(owner_id,id) on delete cascade
);
create index item_spaces_by_space on public.item_spaces(owner_id,space_id,item_id);

create table public.relations (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  from_item_id uuid not null,
  to_item_id uuid not null,
  relation_type text not null check (relation_type in ('inspired_by','elaborates','supports','contradicts','related_to')),
  annotation text not null default '' check (length(annotation)<=10000),
  created_at timestamptz not null default now(),
  primary key(owner_id,id),
  unique(owner_id,from_item_id,to_item_id,relation_type),
  check(from_item_id<>to_item_id),
  check(relation_type<>'related_to' or from_item_id<to_item_id),
  foreign key(owner_id,from_item_id) references public.items(owner_id,id) on delete cascade,
  foreign key(owner_id,to_item_id) references public.items(owner_id,id) on delete cascade
);
create index relations_target on public.relations(owner_id,to_item_id);

create table public.assets (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  item_id uuid not null,
  storage_path text not null unique,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes between 0 and 26214400),
  created_at timestamptz not null default now(),
  primary key(owner_id,id),
  check (split_part(storage_path,'/',1)=owner_id::text and split_part(storage_path,'/',2)=item_id::text),
  foreign key(owner_id,item_id) references public.items(owner_id,id) on delete cascade
);

-- Every synced write first locks this owner's clock row. Cursor allocation is therefore
-- transaction/commit ordered within that owner; a later commit cannot hide a lower cursor.
-- PostgreSQL FOR UPDATE: https://www.postgresql.org/docs/current/explicit-locking.html
create table public.sync_clocks (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  cursor bigint not null default 0 check (cursor>=0)
);
create table public.sync_operations (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  kind text not null check (kind in ('put_note','put_space')),
  entity_id text not null,
  operation jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(owner_id,id)
);
create table public.sync_changes (
  owner_id uuid not null references auth.users(id) on delete cascade,
  cursor bigint not null,
  entity text not null check (entity in ('note','space')),
  entity_id text not null,
  record jsonb not null,
  created_at timestamptz not null default now(),
  primary key(owner_id,cursor)
);
create table public.sync_conflicts (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  operation_id uuid not null,
  entity text not null check (entity in ('note','space')),
  entity_id text not null,
  local_record jsonb not null,
  server_record jsonb not null,
  created_at timestamptz not null default now(),
  primary key(owner_id,id),
  unique(owner_id,operation_id),
  foreign key(owner_id,operation_id) references public.sync_operations(owner_id,id) deferrable initially deferred
);

-- Keep all tables private, including operation payloads and conflict copies.
do $$
declare table_name text;
begin
  foreach table_name in array array['items','notes','spaces','item_spaces','relations','assets','sync_clocks','sync_operations','sync_changes','sync_conflicts'] loop
    execute format('alter table public.%I enable row level security',table_name);
    execute format('revoke all on public.%I from public,anon,authenticated',table_name);
    execute format('grant select on public.%I to authenticated',table_name);
    execute format('create policy owner_select on public.%I for select to authenticated using ((select auth.uid())=owner_id)',table_name);
  end loop;
end;
$$;

-- Relations/assets are not synced in Phase 2, but already enforce owner policies and FKs.
grant insert,update,delete on public.relations,public.assets to authenticated;
create policy owner_insert on public.relations for insert to authenticated with check ((select auth.uid())=owner_id);
create policy owner_update on public.relations for update to authenticated using ((select auth.uid())=owner_id) with check ((select auth.uid())=owner_id);
create policy owner_delete on public.relations for delete to authenticated using ((select auth.uid())=owner_id);
create policy owner_insert on public.assets for insert to authenticated with check ((select auth.uid())=owner_id);
create policy owner_update on public.assets for update to authenticated using ((select auth.uid())=owner_id) with check ((select auth.uid())=owner_id);
create policy owner_delete on public.assets for delete to authenticated using ((select auth.uid())=owner_id);

-- VOLATILE readers see the mutations made earlier by the enclosing write RPC.
-- https://www.postgresql.org/docs/current/xfunc-volatility.html
create function public._sync_note(p_owner uuid,p_id uuid)
returns jsonb language sql volatile set search_path='' as $$
  select jsonb_build_object(
    'id',i.id,'kind','note','originApp',i.origin_app,'ownerId',i.owner_id,
    'body',n.body,'spaceIds',coalesce((select jsonb_agg(s.space_id order by s.space_id) from public.item_spaces s where s.owner_id=i.owner_id and s.item_id=i.id),'[]'::jsonb),
    'pinned',i.pinned,'createdAt',i.created_at,'updatedAt',i.updated_at,'deletedAt',i.deleted_at,
    'localRevision',i.revision,'serverRevision',i.revision)
  from public.items i join public.notes n on n.owner_id=i.owner_id and n.item_id=i.id
  where i.owner_id=p_owner and i.id=p_id and i.kind='note';
$$;
create function public._sync_space(p_owner uuid,p_id text)
returns jsonb language sql volatile set search_path='' as $$
  select jsonb_build_object('id',s.id,'ownerId',s.owner_id,'name',s.name,'color',s.color,'createdAt',s.created_at,'localRevision',s.revision,'serverRevision',s.revision)
  from public.spaces s where s.owner_id=p_owner and s.id=p_id;
$$;
revoke all on function public._sync_note(uuid,uuid),public._sync_space(uuid,text) from public,anon,authenticated;

create function public.apply_sync_operation(p_operation jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_owner uuid := auth.uid();
  v_id uuid;
  v_kind text;
  v_entity_id text;
  v_payload jsonb;
  v_base bigint;
  v_revision bigint;
  v_previous uuid;
  v_predecessor public.sync_operations%rowtype;
  v_existing public.sync_operations%rowtype;
  v_record jsonb;
  v_result jsonb;
  v_conflict uuid;
  v_cursor bigint;
  v_created timestamptz;
  v_deleted timestamptz;
  v_space_id text;
  v_entity text;
  v_has_conflict boolean := false;
begin
  if v_owner is null then raise exception 'Sign in required' using errcode='42501'; end if;
  if p_operation is null or jsonb_typeof(p_operation)<>'object' or octet_length(p_operation::text)>1048576 then
    raise exception 'Invalid operation' using errcode='22023';
  end if;
  v_id := (p_operation->>'id')::uuid;
  v_kind := p_operation->>'kind';
  v_entity_id := p_operation->>'entityId';
  v_payload := p_operation->'payload';
  if v_id is null or v_kind is null or v_kind not in ('put_note','put_space') or v_entity_id is null or length(v_entity_id) not between 1 and 100
    or v_payload is null or jsonb_typeof(v_payload)<>'object' or (v_payload->>'id') is distinct from v_entity_id then
    raise exception 'Invalid operation shape' using errcode='22023';
  end if;
  v_base := (p_operation->>'baseRevision')::bigint;
  if not (p_operation ? 'baseRevision') or jsonb_typeof(p_operation->'baseRevision') not in ('null','number') then
    raise exception 'Invalid revision shape' using errcode='22023';
  end if;
  if v_base is not null and v_base not between 1 and 9007199254740991 then raise exception 'Invalid revision' using errcode='22023'; end if;
  v_previous := (p_operation->>'previousOperationId')::uuid;
  v_entity := case v_kind when 'put_note' then 'note' else 'space' end;

  insert into public.sync_clocks(owner_id) values(v_owner) on conflict(owner_id) do nothing;
  perform 1 from public.sync_clocks where owner_id=v_owner for update;

  select * into v_existing from public.sync_operations where owner_id=v_owner and id=v_id;
  if found then
    if v_existing.operation is distinct from p_operation then raise exception 'Operation ID already used with different content' using errcode='22023'; end if;
    return v_existing.result;
  end if;

  if v_previous is not null then
    select * into v_predecessor from public.sync_operations where owner_id=v_owner and id=v_previous;
    if not found or v_predecessor.kind<>v_kind or v_predecessor.entity_id<>v_entity_id then
      raise exception 'Previous operation not found for this entity' using errcode='22023';
    end if;
    if v_predecessor.result->>'status'='conflict' then v_has_conflict:=true;
    else v_base := (v_predecessor.result->'record'->>'serverRevision')::bigint; end if;
  end if;

  if v_kind='put_note' then
    perform v_entity_id::uuid;
    if (v_payload->>'kind') is distinct from 'note' or (v_payload->>'originApp') is distinct from 'recall'
      or jsonb_typeof(v_payload->'body') is distinct from 'string' or length(btrim(v_payload->>'body')) not between 1 and 100000
      or jsonb_typeof(v_payload->'pinned') is distinct from 'boolean'
      or jsonb_typeof(v_payload->'spaceIds') is distinct from 'array' or jsonb_array_length(v_payload->'spaceIds')>1000 then
      raise exception 'Invalid note' using errcode='22023';
    end if;
    for v_space_id in select jsonb_array_elements_text(v_payload->'spaceIds') loop
      if not exists(select 1 from public.spaces where owner_id=v_owner and id=v_space_id) then
        raise exception 'Space not found in your account' using errcode='23503';
      end if;
    end loop;
    v_record := public._sync_note(v_owner,v_entity_id::uuid);
    if v_record is null and exists(select 1 from public.items where owner_id=v_owner and id=v_entity_id::uuid) then
      raise exception 'Item kind cannot change' using errcode='22023';
    end if;
  else
    if v_entity_id !~ '^[A-Za-z0-9_-]{1,100}$' or jsonb_typeof(v_payload->'name') is distinct from 'string'
      or length(btrim(v_payload->>'name')) not between 1 and 40 or coalesce(v_payload->>'color','') !~ '^#[0-9A-Fa-f]{6}$' then
      raise exception 'Invalid space' using errcode='22023';
    end if;
    v_record := public._sync_space(v_owner,v_entity_id);
  end if;

  v_revision := (v_record->>'serverRevision')::bigint;
  -- The three initial spaces may be seeded independently on several devices.
  if v_kind='put_space' and v_record is not null and v_base is null and not v_has_conflict
    and v_record->>'name'=btrim(v_payload->>'name') and v_record->>'color'=v_payload->>'color' then
    v_result:=jsonb_build_object('status','applied','operationId',v_id,'record',v_record);
  else
    v_has_conflict := v_has_conflict or v_base is distinct from v_revision;
    if v_has_conflict then
      -- A predecessor conflict always has a canonical record. Unknown positive revisions
      -- on an absent entity are invalid, rather than a synthetic/empty canonical record.
      if v_record is null then raise exception 'Entity not found for revision' using errcode='22023'; end if;
      v_conflict:=gen_random_uuid();
      insert into public.sync_conflicts(owner_id,id,operation_id,entity,entity_id,local_record,server_record)
        values(v_owner,v_conflict,v_id,v_entity,v_entity_id,v_payload,v_record);
      v_result:=jsonb_build_object('status','conflict','operationId',v_id,'record',v_record,'conflictId',v_conflict);
    else
      v_revision:=coalesce(v_revision,0)+1;
      v_created:=coalesce((v_record->>'createdAt')::timestamptz,(v_payload->>'createdAt')::timestamptz,now());
      if v_kind='put_note' then
        v_deleted:=(v_payload->>'deletedAt')::timestamptz;
        insert into public.items(owner_id,id,kind,origin_app,title,pinned,created_at,updated_at,deleted_at,revision)
          values(v_owner,v_entity_id::uuid,'note','recall',left(split_part(btrim(v_payload->>'body'),E'\n',1),80),
            (v_payload->>'pinned')::boolean,v_created,clock_timestamp(),v_deleted,v_revision)
          on conflict(owner_id,id) do update set title=excluded.title,pinned=excluded.pinned,
            updated_at=excluded.updated_at,deleted_at=excluded.deleted_at,revision=excluded.revision;
        insert into public.notes(owner_id,item_id,body) values(v_owner,v_entity_id::uuid,btrim(v_payload->>'body'))
          on conflict(owner_id,item_id) do update set body=excluded.body;
        delete from public.item_spaces where owner_id=v_owner and item_id=v_entity_id::uuid;
        insert into public.item_spaces(owner_id,item_id,space_id)
          select distinct v_owner,v_entity_id::uuid,jsonb_array_elements_text(v_payload->'spaceIds');
        v_record:=public._sync_note(v_owner,v_entity_id::uuid);
      else
        insert into public.spaces(owner_id,id,name,color,created_at,revision)
          values(v_owner,v_entity_id,btrim(v_payload->>'name'),v_payload->>'color',v_created,v_revision)
          on conflict(owner_id,id) do update set name=excluded.name,color=excluded.color,revision=excluded.revision;
        v_record:=public._sync_space(v_owner,v_entity_id);
      end if;
      update public.sync_clocks set cursor=cursor+1 where owner_id=v_owner returning cursor into v_cursor;
      insert into public.sync_changes(owner_id,cursor,entity,entity_id,record) values(v_owner,v_cursor,v_entity,v_entity_id,v_record);
      v_result:=jsonb_build_object('status','applied','operationId',v_id,'record',v_record);
    end if;
  end if;
  insert into public.sync_operations(owner_id,id,kind,entity_id,operation,result)
    values(v_owner,v_id,v_kind,v_entity_id,p_operation,v_result);
  return v_result;
end;
$$;
revoke all on function public.apply_sync_operation(jsonb) from public,anon,authenticated;
grant execute on function public.apply_sync_operation(jsonb) to authenticated;

create function public.pull_sync_changes(p_cursor text default '0',p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  v_owner uuid:=auth.uid();
  v_after bigint;
  v_next bigint;
  v_limit integer;
  v_changes jsonb;
begin
  if v_owner is null then raise exception 'Sign in required' using errcode='42501'; end if;
  if p_cursor is null or p_cursor !~ '^[0-9]{1,19}$' then raise exception 'Invalid cursor' using errcode='22023'; end if;
  v_after:=p_cursor::bigint;
  v_limit:=least(greatest(coalesce(p_limit,100),1),200);
  select coalesce(jsonb_agg(jsonb_build_object('cursor',c.cursor::text,'entity',c.entity,'record',c.record) order by c.cursor),'[]'::jsonb),coalesce(max(c.cursor),v_after)
    into v_changes,v_next
    from (select * from public.sync_changes where owner_id=v_owner and cursor>v_after order by cursor limit v_limit) c;
  return jsonb_build_object('changes',v_changes,'cursor',v_next::text,'hasMore',exists(select 1 from public.sync_changes where owner_id=v_owner and cursor>v_next));
end;
$$;
revoke all on function public.pull_sync_changes(text,integer) from public,anon,authenticated;
grant execute on function public.pull_sync_changes(text,integer) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit)
  values('personal-tools-private','personal-tools-private',false,26214400)
  on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit;
create policy personal_tools_private_read on storage.objects for select to authenticated using (
  bucket_id='personal-tools-private' and (storage.foldername(name))[1]=(select auth.uid())::text
  and exists(select 1 from public.items i where i.owner_id=(select auth.uid()) and i.id::text=(storage.foldername(name))[2])
);
create policy personal_tools_private_insert on storage.objects for insert to authenticated with check (
  bucket_id='personal-tools-private' and (storage.foldername(name))[1]=(select auth.uid())::text
  and exists(select 1 from public.items i where i.owner_id=(select auth.uid()) and i.id::text=(storage.foldername(name))[2])
);
create policy personal_tools_private_update on storage.objects for update to authenticated using (
  bucket_id='personal-tools-private' and (storage.foldername(name))[1]=(select auth.uid())::text
  and exists(select 1 from public.items i where i.owner_id=(select auth.uid()) and i.id::text=(storage.foldername(name))[2])
) with check (
  bucket_id='personal-tools-private' and (storage.foldername(name))[1]=(select auth.uid())::text
  and exists(select 1 from public.items i where i.owner_id=(select auth.uid()) and i.id::text=(storage.foldername(name))[2])
);
create policy personal_tools_private_delete on storage.objects for delete to authenticated using (
  bucket_id='personal-tools-private' and (storage.foldername(name))[1]=(select auth.uid())::text
  and exists(select 1 from public.items i where i.owner_id=(select auth.uid()) and i.id::text=(storage.foldername(name))[2])
);

commit;
