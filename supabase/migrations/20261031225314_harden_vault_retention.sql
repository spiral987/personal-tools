begin;
create policy worker_config_deny_direct on private.retention_worker_config for all to public using(false) with check(false);
-- pg_net is not relocatable. Reinstall the newly enabled extension atomically in
-- the extensions schema; requests are retried by the existing ten-minute job.
do $$begin
 if exists(select 1 from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pg_net' and n.nspname='public') then
  drop extension pg_net;
  create extension pg_net with schema extensions;
 end if;
end$$;
commit;
