-- Scheduled account-deletion sweep — Supabase
-- Run in the Supabase Dashboard → SQL Editor.
-- Requires: account_hidden.sql (delete flags + last_seen_at), moderation_preservation.sql
-- (legal_hold + report snapshots), post_reports.sql, user_reports.sql, ad_ecosystem.sql,
-- storage_cleanup.sql (the purge-on-delete trigger).
--
-- WHAT IT DOES
-- Permanently deletes accounts that are eligible for deletion — i.e. a deliberate
-- deletion ("Delete now"/delete_immediately) once it is 48 HOURS old, OR a "hide for
-- 3 months" account that has been inactive ~3 months — BUT ONLY when the account has
-- ZERO OPEN reports and is not under a legal hold.
-- Deleting from auth.users cascades the user's rows and fires the storage-purge
-- trigger, so the account, its data, and its media are all removed.
--
-- Accounts with an OPEN report (a reported post / song / video / slideshow, a reported
-- user / page / story, or a reported ad) — or anything on legal hold — are LEFT
-- UNTOUCHED for manual review and deletion. A RESOLVED report does NOT count: once a
-- moderator marks every report on an account handled (resolved_at set), the account is
-- treated as report-free and the sweep deletes it after the 48h window. See the bottom.

-- A report counts as "open" only while resolved_at is null. A moderator marks a report
-- handled (action taken OR dismissed) with: update <table> set resolved_at = now() where …
alter table public.post_reports add column if not exists resolved_at timestamptz;
alter table public.user_reports add column if not exists resolved_at timestamptz;
alter table public.ad_reports  add column if not exists resolved_at timestamptz;

create or replace function public.sweep_deletable_accounts()
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_id uuid;
  v_count int := 0;
begin
  for v_id in
    select p.id
    from public.profiles p
    where
      -- eligible for deletion
      (
        -- deliberate deletion ("Delete now"): hard delete 48 hours after the request
        (p.delete_immediately = true and p.delete_requested_at <= now() - interval '48 hours')
        -- reversible "hide for 3 months": delete after ~3 months of inactivity
        or (
          coalesce(p.delete_immediately, false) = false
          and p.delete_requested_at is not null
          and coalesce(p.last_seen_at, p.delete_requested_at) < now() - interval '3 months'
        )
      )
      -- never sweep anything under a legal hold
      and coalesce(p.legal_hold, false) = false
      and not exists (
        select 1 from public.posts x where x.user_id = p.id and coalesce(x.legal_hold, false) = true
      )
      -- never sweep an account that has an OPEN (unresolved) report (-> manual deletion)
      and not exists (select 1 from public.user_reports ur where ur.reported_id = p.id and ur.resolved_at is null)
      and not exists (select 1 from public.post_reports pr where pr.reported_user_id = p.id and pr.resolved_at is null)
      and not exists (
        select 1 from public.post_reports pr
        join public.posts pp on pp.id = pr.post_id
        where pp.user_id = p.id and pr.resolved_at is null
      )
      and not exists (
        select 1 from public.ad_reports ar
        join public.ad_campaigns c on c.id = ar.campaign_id
        where c.user_id = p.id and ar.resolved_at is null
      )
  loop
    delete from auth.users where id = v_id;  -- cascades data + fires storage purge
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- The sweep deletes accounts — it must NOT be callable by app users. Only the
-- service role / dashboard / pg_cron (which run as the function owner) may execute it.
revoke execute on function public.sweep_deletable_accounts() from public;

-- ── Client helper: does the CALLER's OWN account have any OPEN report? ────────
-- The app calls this at delete time to decide whether to tell the user the email
-- frees up after 48h — an account with an OPEN report is NOT auto-swept (handled
-- manually), so that promise would be misleading. Only OPEN (resolved_at is null)
-- reports count, so once a moderator resolves them all this returns false and the
-- account gets the 48h message (and is swept). SECURITY DEFINER so a user can learn
-- their own yes/no status WITHOUT being able to see the reports themselves (RLS
-- hides who reported them). It only ever checks auth.uid() and returns a boolean.
create or replace function public.current_account_has_reports()
returns boolean
language sql
security definer
set search_path = public
as $$
  select
    exists (select 1 from public.user_reports ur where ur.reported_id = auth.uid() and ur.resolved_at is null)
    or exists (select 1 from public.post_reports pr where pr.reported_user_id = auth.uid() and pr.resolved_at is null)
    or exists (select 1 from public.post_reports pr join public.posts pp on pp.id = pr.post_id where pp.user_id = auth.uid() and pr.resolved_at is null)
    or exists (select 1 from public.ad_reports ar join public.ad_campaigns c on c.id = ar.campaign_id where c.user_id = auth.uid() and ar.resolved_at is null);
$$;

revoke execute on function public.current_account_has_reports() from public;
grant execute on function public.current_account_has_reports() to authenticated;

-- ── Schedule it (HOURLY, so a deletion lands within ~1h of its 48h mark) ──────
-- pg_cron is available on Supabase; enabling it here is idempotent. Re-running this
-- file replaces the job of the same name. To run on demand instead of (or in addition
-- to) the schedule, just: select public.sweep_deletable_accounts();
create extension if not exists pg_cron;
select cron.schedule('sweep-deletable-accounts', '0 * * * *', $$select public.sweep_deletable_accounts();$$);

-- To stop the schedule later:  select cron.unschedule('sweep-deletable-accounts');

-- ── Manual-review list (run in the dashboard as needed) ───────────────────────
-- Accounts eligible for deletion that the sweep SKIPPED because they have an OPEN
-- report or a legal hold — review these, resolve the reports (set resolved_at, after
-- which the sweep will delete them) or delete by hand (delete from auth.users where
-- id = '<uid>'):
--
--   select p.id, p.username, p.display_name, p.delete_immediately,
--          p.delete_requested_at, p.last_seen_at, p.legal_hold,
--          (select count(*) from public.user_reports ur where ur.reported_id = p.id and ur.resolved_at is null) as open_user_reports,
--          (select count(*) from public.post_reports pr
--             where (pr.reported_user_id = p.id
--                or pr.post_id in (select id from public.posts where user_id = p.id))
--               and pr.resolved_at is null) as open_post_reports,
--          (select count(*) from public.ad_reports ar
--             join public.ad_campaigns c on c.id = ar.campaign_id
--             where c.user_id = p.id and ar.resolved_at is null) as open_ad_reports
--   from public.profiles p
--   where (p.delete_immediately = true
--          or (p.delete_requested_at is not null
--              and coalesce(p.last_seen_at, p.delete_requested_at) < now() - interval '3 months'))
--     and (coalesce(p.legal_hold,false) = true
--          or exists (select 1 from public.posts x where x.user_id = p.id and coalesce(x.legal_hold,false)=true)
--          or exists (select 1 from public.user_reports ur where ur.reported_id = p.id and ur.resolved_at is null)
--          or exists (select 1 from public.post_reports pr where pr.reported_user_id = p.id and pr.resolved_at is null)
--          or exists (select 1 from public.post_reports pr join public.posts pp on pp.id=pr.post_id where pp.user_id = p.id and pr.resolved_at is null)
--          or exists (select 1 from public.ad_reports ar join public.ad_campaigns c on c.id=ar.campaign_id where c.user_id = p.id and ar.resolved_at is null));
