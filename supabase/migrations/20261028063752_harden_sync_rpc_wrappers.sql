-- Generated with `supabase migration new harden_sync_rpc_wrappers`.
-- Additive hardening: do not alter the already-applied Phase 2 migration.
-- SECURITY DEFINER implementations belong outside the Data API's exposed schemas:
-- https://supabase.com/docs/guides/database/postgres/row-level-security#use-security-definer-functions
-- https://supabase.com/docs/guides/api/securing-your-api
begin;

create schema if not exists private;
revoke all on schema private from public,anon,authenticated;

-- Cover the composite owner/item foreign key for metadata lookups and cascades.
create index assets_by_item on public.assets(owner_id,item_id);

-- Preserve function OIDs, data and the tested operation/revision logic while moving
-- the privileged implementations and readers out of the public RPC namespace.
-- https://www.postgresql.org/docs/current/sql-alterfunction.html
alter function public._sync_note(uuid,uuid) set schema private;
alter function public._sync_space(uuid,text) set schema private;
alter function public.apply_sync_operation(jsonb) set schema private;
alter function public.pull_sync_changes(text,integer) set schema private;

-- The existing PL/pgSQL body explicitly qualified its readers in public. Rebind
-- only those two calls; retain all auth.uid checks, table qualifiers and payload
-- validation from the original, already-applied implementation.
-- pg_get_functiondef returns a complete CREATE OR REPLACE statement:
-- https://www.postgresql.org/docs/current/functions-info.html
do $$
declare definition text;
begin
  definition:=pg_get_functiondef('private.apply_sync_operation(jsonb)'::regprocedure);
  definition:=replace(definition,'public._sync_note(','private._sync_note(');
  definition:=replace(definition,'public._sync_space(','private._sync_space(');
  execute definition;
end;
$$;

revoke all on function private._sync_note(uuid,uuid),private._sync_space(uuid,text),
  private.apply_sync_operation(jsonb),private.pull_sync_changes(text,integer)
  from public,anon,authenticated;
grant usage on schema private to authenticated;
grant execute on function private.apply_sync_operation(jsonb),private.pull_sync_changes(text,integer)
  to authenticated;

-- These public names and parameter names are the existing supabase.rpc contract.
-- They execute with the caller's role; the private implementations authenticate
-- auth.uid() and enforce the current owner's scope before privileged access.
create function public.apply_sync_operation(p_operation jsonb)
returns jsonb language sql volatile security invoker set search_path='' as $$
  select private.apply_sync_operation(p_operation);
$$;
create function public.pull_sync_changes(p_cursor text default '0',p_limit integer default 100)
returns jsonb language sql stable security invoker set search_path='' as $$
  select private.pull_sync_changes(p_cursor,p_limit);
$$;
revoke all on function public.apply_sync_operation(jsonb),public.pull_sync_changes(text,integer)
  from public,anon,authenticated;
grant execute on function public.apply_sync_operation(jsonb),public.pull_sync_changes(text,integer)
  to authenticated;

comment on schema private is 'Internal Personal Tools functions. Never add this schema to Data API exposed schemas.';
comment on function public.apply_sync_operation(jsonb) is 'Authenticated invoker entry point; owner-checked atomic implementation is private.';
comment on function public.pull_sync_changes(text,integer) is 'Authenticated invoker entry point; owner-scoped implementation is private.';

commit;
