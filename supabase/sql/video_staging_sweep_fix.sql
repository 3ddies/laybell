-- ───────────────────────────────────────────────────────────────────────────
-- video-staging sweep — moved out of SQL. APPLIED 2026-08-09.
--
-- WHAT BROKE: video_staging.sql scheduled public.sweep_video_staging() hourly
-- on pg_cron, and that function DELETEs straight out of storage.objects.
-- Supabase later added storage.protect_delete(), a trigger that raises on any
-- direct delete from that table. From 2026-08-07 the job therefore failed on
-- EVERY run — ~60 consecutive silent failures, found only by auditing
-- cron.job_run_details. Meanwhile every film upload stages a multi-GB master,
-- so the bucket only grew.
--
-- THE FIX: deletion now goes through the Storage API from the `staging-sweep`
-- Edge Function, invoked fire-and-forget at app boot beside stream-reap (SQL
-- can't make HTTP calls here — pg_net isn't installed). The function still
-- needs the stale list from SQL, and the storage schema isn't exposed over
-- PostgREST, so it asks through the security-definer function below.
--
-- Idempotent; safe to re-run.
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.video_staging_stale_paths(p_hours int default 24)
returns text[]
language sql
security definer
set search_path = public
as $$
  select coalesce(array_agg(o.name order by o.created_at), '{}')
  from storage.objects o
  where o.bucket_id = 'video-staging'
    and o.created_at < now() - make_interval(hours => greatest(1, p_hours))
  limit 1;
$$;

-- Only the Edge Function (service role) may enumerate the bucket.
revoke execute on function public.video_staging_stale_paths(int) from public, anon;
grant execute on function public.video_staging_stale_paths(int) to service_role;

-- The old sweeper can never work again; drop it so nobody re-schedules it.
drop function if exists public.sweep_video_staging();

-- And retire the job itself. (Run once; harmless if already gone.)
--   select cron.unschedule('sweep-video-staging');
