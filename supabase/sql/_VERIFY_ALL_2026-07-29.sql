-- ═══════════════════════════════════════════════════════════════════════════
-- LAYBELL — "WHAT IS ACTUALLY IN THE DATABASE" CHECK
--
-- READ-ONLY. Creates nothing, changes nothing. Safe to run any number of times.
--
-- WHY THIS EXISTS
-- Nothing in the database records which migrations have been run. Every
-- "applied" claim in docs/LAUNCH_CHECKLIST.md is prose, and on 2026-07-29 three
-- of those claims were wrong in each direction: files marked applied that never
-- ran, and files marked pending that had. This asks Postgres instead.
--
-- HOW TO READ IT
-- Failures sort to the top. Every row has the exact file to run in `fix`.
-- An all-✅ result means every object below exists — it does NOT prove the
-- newest VERSION of each function is deployed, which is why the first check
-- inspects a function body rather than its existence.
-- ═══════════════════════════════════════════════════════════════════════════

select
  case when present then '✅' else '❌ MISSING' end as status,
  item,
  case when present then '' else fix end as fix
from (

  -- ─── The one known-stale function ───────────────────────────────────────
  -- delivered_earnings() was applied 2026-07-28 hardcoding the seller's share
  -- as `* 0.85`, then rewritten 2026-07-29 to derive it from shop_fee_rate().
  -- Existence is not enough here: the OLD version exists and is wrong, and it
  -- overstates every seller's balance by 15 points of gross.
  select 'delivered_earnings() derives the fee from shop_fee_rate()' as item,
         exists (select 1 from pg_proc p
                 join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'delivered_earnings'
                   and p.prosrc like '%shop_fee_rate%') as present,
         'RE-RUN supabase/sql/wallet_earnings.sql' as fix

  -- ─── Tier-1 set — never verified against the live DB ────────────────────
  union all select 'message_reactions table',
    to_regclass('public.message_reactions') is not null,
    'run message_reactions.sql'
  union all select 'conversations table (group chats)',
    to_regclass('public.conversations') is not null,
    'run group_chats.sql (after message_reactions.sql)'
  union all select 'conversation_members table',
    to_regclass('public.conversation_members') is not null,
    'run group_chats.sql'
  union all select 'conversation_reports table',
    to_regclass('public.conversation_reports') is not null,
    'run conversation_reports.sql'
  union all select 'messages DELETE policy (users delete own messages)',
    exists (select 1 from pg_policies
            where schemaname = 'public' and tablename = 'messages' and cmd = 'DELETE'),
    'run message_delete.sql'
  union all select 'user_gifs table',
    to_regclass('public.user_gifs') is not null,
    'run user_gifs.sql'
  union all select 'scale_indexes #1 — posts_created_at_idx',
    to_regclass('public.posts_created_at_idx') is not null,
    'run scale_indexes.sql'
  union all select 'scale_indexes #1 — likes_post_id_idx',
    to_regclass('public.likes_post_id_idx') is not null,
    'run scale_indexes.sql'
  union all select 'scale_indexes #1 — notifications_user_unread_idx',
    to_regclass('public.notifications_user_unread_idx') is not null,
    'run scale_indexes.sql'
  union all select 'scale_indexes #2 — messages 1:1 DM index',
    exists (select 1 from pg_indexes
            where schemaname = 'public' and tablename = 'messages'
              and indexdef like '%receiver_id%'),
    'run scale_indexes_2.sql'

  -- ─── The 2026-07-29 pending bundle ──────────────────────────────────────
  union all select 'profiles.stripe_account_id (payouts depend on it)',
    exists (select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'profiles'
              and column_name = 'stripe_account_id'),
    'run _RUN_PENDING_2026-07-29.sql'
  union all select 'access_log table (NCMEC + chargeback evidence)',
    to_regclass('public.access_log') is not null,
    'run _RUN_PENDING_2026-07-29.sql'
  union all select 'copyright_notices table (DMCA intake)',
    to_regclass('public.copyright_notices') is not null,
    'run _RUN_PENDING_2026-07-29.sql'
  union all select 'copyright_strikes table (repeat-infringer counter)',
    to_regclass('public.copyright_strikes') is not null,
    'run _RUN_PENDING_2026-07-29.sql'
  union all select 'add_business_days() (counter-notice putback clock)',
    exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'add_business_days'),
    'run _RUN_PENDING_2026-07-29.sql'
  union all select 'posts.sound_opt_in ("use this sound" consent)',
    exists (select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'posts'
              and column_name = 'sound_opt_in'),
    'run _RUN_PENDING_2026-07-29.sql'
  union all select 'withdraw_sound() (the global kill switch)',
    exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'withdraw_sound'),
    'run _RUN_PENDING_2026-07-29.sql'
  union all select 'live_streams.save_replay (replay is opt-in)',
    exists (select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'live_streams'
              and column_name = 'save_replay'),
    'run _RUN_PENDING_2026-07-29.sql'
  union all select 'stream_hours_daily table (BMI Tier-1 meter)',
    to_regclass('public.stream_hours_daily') is not null,
    'run _RUN_PENDING_2026-07-29.sql'

  -- ─── Money surfaces that must already be live ───────────────────────────
  union all select 'ledger_entries table (the money source of truth)',
    to_regclass('public.ledger_entries') is not null,
    'run ledger.sql — see LAUNCH_CHECKLIST 3.1'
  union all select 'request_payout() (creator payouts)',
    exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'request_payout'),
    'run payouts.sql'
  union all select 'tip_with_credits() (tips charge real credits)',
    exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'tip_with_credits'),
    'run ledger_spend.sql'
  union all select 'spotlight_buy_with_credits() (Spotlight charges)',
    exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'spotlight_buy_with_credits'),
    'run promo_credits.sql'
  union all select 'ad_campaign_fund_with_credits() (Ad Manager charges)',
    exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'ad_campaign_fund_with_credits'),
    'run promo_credits.sql'
  union all select 'blocked_terms table (Apple 1.2 content filter)',
    to_regclass('public.blocked_terms') is not null,
    'run content_filter.sql'

  -- ─── Storage buckets — created by hand, in no SQL file ──────────────────
  union all select 'storage bucket: posts',
    exists (select 1 from storage.buckets where id = 'posts'),
    'create it in Dashboard -> Storage (no SQL file makes it)'
  union all select 'storage bucket: avatars',
    exists (select 1 from storage.buckets where id = 'avatars'),
    'create it in Dashboard -> Storage (no SQL file makes it)'

) t
order by present, item;
