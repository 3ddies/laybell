-- Laybell health check — run WEEKLY.  Created 2026-08-24.
--
--   npx supabase db query --linked -f supabase/sql/_HEALTH_CHECK.sql
--
-- ─── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
-- Every serious problem this project has hit was SILENT. Not one announced
-- itself; each was found by someone happening to look:
--
--   • pg_cron reported "succeeded" hourly for a week while deleting nothing,
--     because an exception handler swallowed the error.
--   • A storage purge trigger caught every exception by design, so 248 files
--     survived an account wipe and kept serving and billing.
--   • A realtime table published nothing; the schema audit could not see it.
--   • share-page leaked hidden profiles, unnoticed because production had zero
--     hidden accounts — no data in the failing state, therefore no symptom.
--   • A "REMOVE BEFORE RELEASE" test override shipped to both stores.
--
-- The lesson each time: **monitor the OUTCOME, never the job status.** A green
-- cron row means the function returned, not that it did anything. Every check
-- below asks "is the world in the right state", not "did something run".
--
-- Anything non-zero in a `_must_be_0` column deserves investigation before it
-- becomes a support ticket.

select
  -- ── MONEY. If either of these moves, money was created or destroyed. ──────
  (select count(*) from public.ledger_verify())                           as ledger_violations_must_be_0,
  (select coalesce(sum(amount_cents), 0) from public.ledger_entries)      as global_sum_must_be_0,
  (select count(*) from public.ledger_accounts
    where kind <> 'platform' and balance_cents < 0)                       as negative_user_balances_must_be_0,

  -- ── ACCOUNT DELETION. The health signal is the OVERDUE COUNT, never the
  --    cron status — that is exactly what lied for a week. Three separate
  --    blockers hid behind each other here (follow_events, access_log,
  --    ledger RESTRICT), so treat any non-zero as a fourth until disproven.
  (select count(*) from public.profiles
    where delete_immediately = true
      and delete_requested_at <= now() - interval '48 hours')             as deletion_overdue_must_be_0,
  (select count(*) from public.profiles
    where delete_requested_at is not null)                                as deletions_pending,

  -- ── VIDEO. Stuck uploads are invisible to the uploader and bill monthly. ──
  (select count(*) from public.posts
    where type = 'video' and coalesce(media_url, '') = '')                as videos_stuck_processing,

  -- ── MODERATION. Open reports block automatic deletion by design, so a
  --    growing number here is a queue nobody is working, not a bug.
  (select count(*) from public.post_reports where resolved_at is null)    as open_post_reports,
  (select count(*) from public.user_reports where resolved_at is null)    as open_user_reports,
  (select count(*) from public.profiles where legal_hold = true)          as accounts_under_legal_hold,

  -- ── SCALE. Context for everything above. ─────────────────────────────────
  (select count(*) from auth.users)                                       as accounts,
  (select count(*) from public.posts)                                     as posts,
  (select count(*) from storage.objects)                                  as storage_objects,

  -- ── GUARDS still in place. Both were added to close real holes. ──────────
  (select count(*) from public.reserved_usernames)                        as reserved_names_should_be_2,
  (select count(*) from public.profiles where badge_tier = 'diamond')     as diamond_accounts_should_be_2;

-- ─── ALSO WORTH A LOOK, less often ──────────────────────────────────────────
--
-- Cron jobs are still scheduled and active (their STATUS is not proof of work,
-- but a job that has stopped existing certainly is a problem):
--   select jobname, schedule, active from cron.job order by jobname;
--
-- Cloudflare Stream orphans — videos nothing in the database references, which
-- bill monthly forever. Dry run, safe:
--   node scripts/stream-sweep.mjs
--
-- Before ANY store submission, re-run both audits. They found six real problems
-- the last time, including a two-day-stale RevenueCat webhook that would have
-- given $19.99 buyers the $9.99 tier:
--   node scripts/schema-audit.mjs && npx supabase db query --linked -f scripts/.schema-audit.sql
--   npx supabase functions list --project-ref wawpaokvtptfmuygjnns
--
-- ─── DATED COMMITMENTS — nothing will remind you ────────────────────────────
--   2027-02-23  the owner Diamond bridge lapses (_OWNER_diamond_bridge_6mo.sql)
--   early 2027-07  BMI + ASCAP renewals. NEITHER auto-renews, and both end
--                  within days of each other. A lapsed licence while live is the
--                  exact exposure they were bought to prevent.
