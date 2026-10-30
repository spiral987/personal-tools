-- Generated with Supabase CLI 2.122.0 migration new phase3_sketchbook.
-- Additive schema: editable stroke JSON is canonical; PNGs are private derived previews.
-- https://supabase.com/docs/guides/database/postgres/row-level-security
-- https://supabase.com/docs/guides/storage/security/access-control
begin;

create table public.sketches (
  owner_id uuid not null,
  item_id uuid not null,
  width integer not null default 1200 check(width=1200),
  height integer not null default 800 check(height=800),
  strokes jsonb not null default '[]' check(jsonb_typeof(strokes)='array' and jsonb_array_length(strokes)<=2000 and octet_length(strokes::text)<=850000),
  primary key(owner_id,item_id),
  foreign key(owner_id,item_id) references public.items(owner_id,id) on delete cascade
);
alter table public.sketches enable row level security;
create policy owner_read on public.sketches for select to authenticated using((select auth.uid())=owner_id);
revoke all on public.sketches from public,anon,authenticated;
grant select on public.sketches to authenticated;

alter table public.relations add column updated_at timestamptz not null default now(),
  add column deleted_at timestamptz,
  add column revision bigint not null default 1 check(revision between 1 and 9007199254740991);
alter table public.assets add column source_revision bigint;
-- Canonical mutations must pass the operation journal and preview revision check.
revoke insert,update,delete on public.relations,public.assets from authenticated;
alter table public.sync_operations drop constraint sync_operations_kind_check;
alter table public.sync_operations add constraint sync_operations_kind_check check(kind in ('put_note','put_space','put_sketch','put_relation'));
alter table public.sync_changes drop constraint sync_changes_entity_check;
alter table public.sync_changes add constraint sync_changes_entity_check check(entity in ('note','space','sketch','relation'));
alter table public.sync_conflicts drop constraint sync_conflicts_entity_check;
alter table public.sync_conflicts add constraint sync_conflicts_entity_check check(entity in ('note','space','sketch','relation'));

create function private._sync_sketch(p_owner uuid,p_id uuid)
returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',i.id,'kind','sketch','originApp','sketchbook','ownerId',i.owner_id,
   'title',i.title,'width',s.width,'height',s.height,'strokes',s.strokes,
   'spaceIds',coalesce((select jsonb_agg(x.space_id order by x.space_id) from public.item_spaces x where x.owner_id=p_owner and x.item_id=p_id),'[]'::jsonb),
   'pinned',i.pinned,'createdAt',i.created_at,'updatedAt',i.updated_at,'deletedAt',i.deleted_at,'localRevision',1,'serverRevision',i.revision)
 from public.items i join public.sketches s on s.owner_id=i.owner_id and s.item_id=i.id
 where i.owner_id=p_owner and i.id=p_id and i.kind='sketch';
$$;
create function private._sync_relation(p_owner uuid,p_id uuid)
returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',r.id,'kind','relation','ownerId',r.owner_id,'fromItemId',r.from_item_id,'toItemId',r.to_item_id,
   'type',r.relation_type,'createdAt',r.created_at,'updatedAt',r.updated_at,'deletedAt',r.deleted_at,'localRevision',1,'serverRevision',r.revision)
 from public.relations r where r.owner_id=p_owner and r.id=p_id;
$$;
revoke all on function private._sync_sketch(uuid,uuid),private._sync_relation(uuid,uuid) from public,anon,authenticated;

-- Keep the proven Phase 2 operation path unchanged, including its immutable replay logic.
alter function private.apply_sync_operation(jsonb) rename to _apply_phase2_operation;
revoke all on function private._apply_phase2_operation(jsonb) from public,anon,authenticated;

create function private.apply_sync_operation(p_operation jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_owner uuid:=auth.uid(); v_id uuid; v_kind text; v_entity text; v_entity_id uuid; v_payload jsonb;
 v_base bigint; v_revision bigint; v_previous uuid; v_predecessor public.sync_operations%rowtype;
 v_existing public.sync_operations%rowtype; v_record jsonb; v_result jsonb; v_conflict uuid;
 v_cursor bigint; v_created timestamptz; v_deleted timestamptz; v_space_id text;
 v_stroke jsonb; v_point jsonb; v_points integer:=0; v_ids text[]:='{}'; v_from uuid; v_to uuid;
 v_has_conflict boolean:=false;
begin
 if v_owner is null then raise exception 'Sign in required' using errcode='42501'; end if;
 if p_operation->>'kind' in ('put_note','put_space') then return private._apply_phase2_operation(p_operation); end if;
 if p_operation is null or jsonb_typeof(p_operation)<>'object' or octet_length(p_operation::text)>1048576 then raise exception 'Invalid operation' using errcode='22023'; end if;
 v_id:=(p_operation->>'id')::uuid; v_kind:=p_operation->>'kind'; v_payload:=p_operation->'payload';
 v_entity_id:=(p_operation->>'entityId')::uuid;
 if v_id is null or v_entity_id is null or v_kind is null or v_kind not in ('put_sketch','put_relation') or v_payload is null
   or jsonb_typeof(v_payload)<>'object' or (v_payload->>'id') is distinct from v_entity_id::text then raise exception 'Invalid operation shape' using errcode='22023'; end if;
 if not(p_operation ? 'baseRevision') or jsonb_typeof(p_operation->'baseRevision') not in ('null','number') then raise exception 'Invalid revision shape' using errcode='22023'; end if;
 v_base:=(p_operation->>'baseRevision')::bigint;
 if v_base is not null and v_base not between 1 and 9007199254740991 then raise exception 'Invalid revision' using errcode='22023'; end if;
 v_previous:=(p_operation->>'previousOperationId')::uuid; v_entity:=substr(v_kind,5);
 insert into public.sync_clocks(owner_id) values(v_owner) on conflict(owner_id) do nothing;
 perform 1 from public.sync_clocks where owner_id=v_owner for update;
 select * into v_existing from public.sync_operations where owner_id=v_owner and id=v_id;
 if found then
   if v_existing.operation is distinct from p_operation then raise exception 'Operation ID already used with different content' using errcode='22023'; end if;
   return v_existing.result;
 end if;
 if v_previous is not null then
   select * into v_predecessor from public.sync_operations where owner_id=v_owner and id=v_previous;
   if not found or v_predecessor.kind<>v_kind or v_predecessor.entity_id<>v_entity_id::text then raise exception 'Previous operation not found for this entity' using errcode='22023'; end if;
   if v_predecessor.result->>'status'='conflict' then v_has_conflict:=true;
   else v_base:=(v_predecessor.result->'record'->>'serverRevision')::bigint; end if;
 end if;
 if v_kind='put_sketch' then
   if (v_payload->>'kind') is distinct from 'sketch' or (v_payload->>'originApp') is distinct from 'sketchbook'
     or jsonb_typeof(v_payload->'title') is distinct from 'string' or length(v_payload->>'title')>120
     or (v_payload->>'width') is distinct from '1200' or (v_payload->>'height') is distinct from '800'
     or jsonb_typeof(v_payload->'pinned') is distinct from 'boolean'
     or jsonb_typeof(v_payload->'strokes') is distinct from 'array'
     or jsonb_array_length(v_payload->'strokes')>2000 or octet_length((v_payload->'strokes')::text)>850000
     or jsonb_typeof(v_payload->'spaceIds') is distinct from 'array' or jsonb_array_length(v_payload->'spaceIds')>1000 then raise exception 'Invalid sketch' using errcode='22023'; end if;
   for v_stroke in select jsonb_array_elements(v_payload->'strokes') loop
     if jsonb_typeof(v_stroke)<>'object' or coalesce(v_stroke->>'id','') !~ '^[A-Za-z0-9_-]{1,100}$' or (v_stroke->>'id')=any(v_ids)
       or coalesce(v_stroke->>'tool','') not in ('pen','eraser') or coalesce(v_stroke->>'color','') !~ '^#[0-9A-Fa-f]{6}$'
       or jsonb_typeof(v_stroke->'width') is distinct from 'number' or (v_stroke->>'width')::numeric not between 1 and 80
       or jsonb_typeof(v_stroke->'points') is distinct from 'array' or jsonb_array_length(v_stroke->'points')<1 then raise exception 'Invalid stroke' using errcode='22023'; end if;
     v_ids:=array_append(v_ids,v_stroke->>'id'); v_points:=v_points+jsonb_array_length(v_stroke->'points');
     if v_points>20000 then raise exception 'Too many drawing points' using errcode='22023'; end if;
     for v_point in select jsonb_array_elements(v_stroke->'points') loop
       if jsonb_typeof(v_point)<>'object' or jsonb_typeof(v_point->'x') is distinct from 'number' or jsonb_typeof(v_point->'y') is distinct from 'number'
         or jsonb_typeof(v_point->'pressure') is distinct from 'number' or (v_point->>'x')::numeric not between 0 and 1200
         or (v_point->>'y')::numeric not between 0 and 800 or (v_point->>'pressure')::numeric not between 0 and 1 then raise exception 'Invalid drawing point' using errcode='22023'; end if;
     end loop;
   end loop;
   for v_space_id in select jsonb_array_elements_text(v_payload->'spaceIds') loop
     if not exists(select 1 from public.spaces where owner_id=v_owner and id=v_space_id) then raise exception 'Space not found in your account' using errcode='23503'; end if;
   end loop;
   v_record:=private._sync_sketch(v_owner,v_entity_id);
   if v_record is null and exists(select 1 from public.items where owner_id=v_owner and id=v_entity_id) then raise exception 'Item kind cannot change' using errcode='22023'; end if;
 else
   if (v_payload->>'kind') is distinct from 'relation' or (v_payload->>'type') is distinct from 'inspired_by' then raise exception 'Invalid relation' using errcode='22023'; end if;
   v_from:=(v_payload->>'fromItemId')::uuid; v_to:=(v_payload->>'toItemId')::uuid;
   if v_from is null or v_to is null or v_from=v_to then raise exception 'Invalid relation endpoints' using errcode='22023'; end if;
   v_record:=private._sync_relation(v_owner,v_entity_id);
   if v_record is not null and ((v_record->>'fromItemId')::uuid<>v_from or (v_record->>'toItemId')::uuid<>v_to) then raise exception 'Relation endpoints cannot change' using errcode='22023'; end if;
   if not exists(select 1 from public.items where owner_id=v_owner and id=v_from and kind='sketch')
     or not exists(select 1 from public.items where owner_id=v_owner and id=v_to and kind='note') then raise exception 'Relation item not found in your account' using errcode='23503'; end if;
 end if;
 v_revision:=(v_record->>'serverRevision')::bigint;
 -- Normal clients use a deterministic edge UUID, so two devices can link the same source.
 if v_kind='put_relation' and v_record is not null and v_base is null and not v_has_conflict
   and (v_record->>'deletedAt') is null and (v_payload->>'deletedAt') is null then
   v_result:=jsonb_build_object('status','applied','operationId',v_id,'record',v_record);
   insert into public.sync_operations(owner_id,id,kind,entity_id,operation,result) values(v_owner,v_id,v_kind,v_entity_id::text,p_operation,v_result);
   return v_result;
 end if;
 v_has_conflict:=v_has_conflict or v_base is distinct from v_revision;
 if v_has_conflict then
   if v_record is null then raise exception 'Entity not found for revision' using errcode='22023'; end if;
   v_conflict:=gen_random_uuid();
   insert into public.sync_conflicts(owner_id,id,operation_id,entity,entity_id,local_record,server_record) values(v_owner,v_conflict,v_id,v_entity,v_entity_id::text,v_payload,v_record);
   v_result:=jsonb_build_object('status','conflict','operationId',v_id,'record',v_record,'conflictId',v_conflict);
 else
   v_revision:=coalesce(v_revision,0)+1;
   v_created:=coalesce((v_record->>'createdAt')::timestamptz,(v_payload->>'createdAt')::timestamptz,now());
   v_deleted:=(v_payload->>'deletedAt')::timestamptz;
   if v_kind='put_sketch' then
     insert into public.items(owner_id,id,kind,origin_app,title,pinned,created_at,updated_at,deleted_at,revision)
       values(v_owner,v_entity_id,'sketch','sketchbook',btrim(v_payload->>'title'),(v_payload->>'pinned')::boolean,v_created,clock_timestamp(),v_deleted,v_revision)
       on conflict(owner_id,id) do update set title=excluded.title,pinned=excluded.pinned,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at,revision=excluded.revision;
     insert into public.sketches(owner_id,item_id,strokes) values(v_owner,v_entity_id,v_payload->'strokes') on conflict(owner_id,item_id) do update set strokes=excluded.strokes;
     delete from public.item_spaces where owner_id=v_owner and item_id=v_entity_id;
     insert into public.item_spaces(owner_id,item_id,space_id) select distinct v_owner,v_entity_id,jsonb_array_elements_text(v_payload->'spaceIds');
     v_record:=private._sync_sketch(v_owner,v_entity_id);
   else
     insert into public.relations(owner_id,id,from_item_id,to_item_id,relation_type,created_at,updated_at,deleted_at,revision)
       values(v_owner,v_entity_id,v_from,v_to,'inspired_by',v_created,clock_timestamp(),v_deleted,v_revision)
       on conflict(owner_id,id) do update set updated_at=excluded.updated_at,deleted_at=excluded.deleted_at,revision=excluded.revision;
     v_record:=private._sync_relation(v_owner,v_entity_id);
   end if;
   update public.sync_clocks set cursor=cursor+1 where owner_id=v_owner returning cursor into v_cursor;
   insert into public.sync_changes(owner_id,cursor,entity,entity_id,record) values(v_owner,v_cursor,v_entity,v_entity_id::text,v_record);
   v_result:=jsonb_build_object('status','applied','operationId',v_id,'record',v_record);
 end if;
 insert into public.sync_operations(owner_id,id,kind,entity_id,operation,result) values(v_owner,v_id,v_kind,v_entity_id::text,p_operation,v_result);
 return v_result;
end;
$$;
revoke all on function private.apply_sync_operation(jsonb) from public,anon,authenticated;
grant execute on function private.apply_sync_operation(jsonb) to authenticated;

-- Preserve v2 clients: their stream never contains new entity types or empty hasMore pages.
create or replace function private.pull_sync_changes(p_cursor text default '0',p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid:=auth.uid(); v_after bigint; v_next bigint; v_limit integer; v_changes jsonb;
begin
 if v_owner is null then raise exception 'Sign in required' using errcode='42501'; end if;
 if p_cursor is null or p_cursor !~ '^[0-9]{1,19}$' then raise exception 'Invalid cursor' using errcode='22023'; end if;
 v_after:=p_cursor::bigint; v_limit:=least(greatest(coalesce(p_limit,100),1),200);
 select coalesce(jsonb_agg(jsonb_build_object('cursor',c.cursor::text,'entity',c.entity,'record',c.record) order by c.cursor),'[]'::jsonb),coalesce(max(c.cursor),v_after)
 into v_changes,v_next from (select * from public.sync_changes where owner_id=v_owner and cursor>v_after and entity in ('note','space') order by cursor limit v_limit) c;
 return jsonb_build_object('changes',v_changes,'cursor',v_next::text,'hasMore',exists(select 1 from public.sync_changes where owner_id=v_owner and cursor>v_next and entity in ('note','space')));
end;
$$;
create function private.pull_suite_changes(p_cursor text default '0',p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid:=auth.uid(); v_after bigint; v_next bigint; v_limit integer; v_changes jsonb;
begin
 if v_owner is null then raise exception 'Sign in required' using errcode='42501'; end if;
 if p_cursor is null or p_cursor !~ '^[0-9]{1,19}$' then raise exception 'Invalid cursor' using errcode='22023'; end if;
 v_after:=p_cursor::bigint; v_limit:=least(greatest(coalesce(p_limit,100),1),200);
 select coalesce(jsonb_agg(jsonb_build_object('cursor',c.cursor::text,'entity',c.entity,'record',c.record) order by c.cursor),'[]'::jsonb),coalesce(max(c.cursor),v_after)
 into v_changes,v_next from (select * from public.sync_changes where owner_id=v_owner and cursor>v_after order by cursor limit v_limit) c;
 return jsonb_build_object('changes',v_changes,'cursor',v_next::text,'hasMore',exists(select 1 from public.sync_changes where owner_id=v_owner and cursor>v_next));
end;
$$;
create function public.pull_suite_changes(p_cursor text default '0',p_limit integer default 100)
returns jsonb language sql stable security invoker set search_path='' as $$ select private.pull_suite_changes(p_cursor,p_limit); $$;
revoke all on function private.pull_suite_changes(text,integer),public.pull_suite_changes(text,integer) from public,anon,authenticated;
grant execute on function private.pull_suite_changes(text,integer),public.pull_suite_changes(text,integer) to authenticated;

create function private.register_sketch_preview(p_item_id uuid,p_revision bigint,p_path text,p_size integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid(); v_id uuid;
begin
 if v_owner is null then raise exception 'Sign in required' using errcode='42501'; end if;
 if p_size is null or p_size not between 8 and 2097152 or p_path is null
   or p_path is distinct from (v_owner::text||'/'||p_item_id::text||'/previews/'||p_revision::text||'-preview.png') then raise exception 'Invalid preview path or size' using errcode='22023'; end if;
 perform 1 from public.items where owner_id=v_owner and id=p_item_id and kind='sketch' and revision=p_revision and deleted_at is null for share;
 if not found then raise exception 'Sketch revision changed' using errcode='22023'; end if;
 if not exists(select 1 from storage.objects where bucket_id='personal-tools-private' and name=p_path) then raise exception 'Preview upload not found' using errcode='22023'; end if;
 insert into public.assets(owner_id,item_id,storage_path,mime_type,size_bytes,source_revision)
   values(v_owner,p_item_id,p_path,'image/png',p_size,p_revision) on conflict(storage_path) do update set source_revision=excluded.source_revision returning id into v_id;
 return jsonb_build_object('id',v_id,'path',p_path,'revision',p_revision);
end;
$$;
create function public.register_sketch_preview(p_item_id uuid,p_revision bigint,p_path text,p_size integer)
returns jsonb language sql volatile security invoker set search_path='' as $$ select private.register_sketch_preview(p_item_id,p_revision,p_path,p_size); $$;
revoke all on function private.register_sketch_preview(uuid,bigint,text,integer),public.register_sketch_preview(uuid,bigint,text,integer) from public,anon,authenticated;
grant execute on function private.register_sketch_preview(uuid,bigint,text,integer),public.register_sketch_preview(uuid,bigint,text,integer) to authenticated;
commit;
