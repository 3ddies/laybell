-- Access-log retention, actually enforced.
--
-- access_log.sql declared a 13-month retention period but shipped the delete as
-- a COMMENT for someone to run by hand, so nothing ever pruned it. A retention
-- period you state publicly and do not enforce is worse than not stating one:
-- the privacy label, the Privacy Policy and the DSAR answer all become untrue
-- the moment the first row passes 13 months, and every IP address ever logged
-- sits there indefinitely. This turns the comment into a scheduled job.
--
-- 13 months is chosen in access_log.sql: comfortably past the ~120-day card
-- dispute window and past the 1-year CSAM preservation duty (18 U.S.C.
-- 2258A(h)), without keeping personal data forever.
--
--   npx supabase db query --linked -f supabase/sql/access_log_retention.sql

-- ─── Prune ──────────────────────────────────────────────────────────────────
create or replace function public.prune_access_log()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  with doomed as (
    delete from public.access_log l
    where l.created_at < now() - interval '13 months'
      -- LEGAL HOLD WINS. access_log.sql is explicit that rows tied to an open
      -- matter must outlive the schedule: their retention clock is set by the
      -- investigation, not by this job. Deleting evidence under hold is
      -- spoliation, so the two exclusions below are the point of this function
      -- rather than a refinement of it — a bare `delete ... where created_at <`
      -- (the statement that was sitting in the comment) would destroy it.
      and not exists (
        select 1 from public.profiles p
        where p.id = l.user_id
          and coalesce(p.legal_hold, false)
      )
      and not exists (
        select 1 from public.posts x
        where l.subject_type = 'post'
          and l.subject_id = x.id::text
          and coalesce(x.legal_hold, false)
      )
    returning 1
  )
  select count(*) into v_deleted from doomed;
  return v_deleted;
end;
$$;

comment on function public.prune_access_log() is
  'Deletes access_log rows older than 13 months, preserving anything tied to a post or profile under legal_hold. Scheduled monthly as prune-access-log.';

-- Supabase grants EXECUTE on every new public function to anon+authenticated by
-- DEFAULT, and `revoke ... from public` does NOT undo that — the roles hold the
-- grant by name, so they must be revoked by name.
revoke all on function public.prune_access_log() from public;
revoke all on function public.prune_access_log() from anon;
revoke all on function public.prune_access_log() from authenticated;

-- ─── Schedule: 03:30 UTC on the 1st of each month ───────────────────────────
-- Monthly, not daily: the window is 13 months, so a few weeks of slack costs
-- nothing and this keeps a delete off the hourly rotation.
select cron.schedule('prune-access-log', '30 3 1 * *', $$select public.prune_access_log();$$);

-- ─── Verify ─────────────────────────────────────────────────────────────────
-- Job is registered:
--   select jobname, schedule, active from cron.job where jobname = 'prune-access-log';
-- anon/authenticated cannot call it (both must be absent from proacl):
--   select proacl from pg_proc where proname = 'prune_access_log';
