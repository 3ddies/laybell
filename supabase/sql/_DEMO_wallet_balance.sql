-- DEMO MONEY — for the App Store wallet screenshot. NOT A REAL BALANCE.
--
--   npx supabase db query --linked -f supabase/sql/_DEMO_wallet_balance.sql
--   npx supabase db query --linked -f supabase/sql/_DEMO_wallet_balance_REVERSE.sql   <-- undo
--
-- ⚠️ REVERSE THIS BEFORE LAUNCH. It is on the launch-day list in
-- docs/LAUNCH_CHECKLIST.md §0.0 for a reason:
--
--   The wallet's headline figure is `earnings.availableCents` — the WITHDRAWABLE
--   balance. So this does not merely paint a number on a screen: it makes $58.00
--   genuinely eligible for payout. Once Stripe is in live mode and
--   payoutsAvailable() is on, "Transfer to bank" would move fifty-eight real
--   dollars out of Laybell's Stripe balance against value that never existed.
--
-- It cannot be deleted, either. The ledger is append-only by constraint — the
-- correct undo is the mirror transaction in the REVERSE file, which is how
-- double-entry has always handled a mistake.
--
-- Why the ledger at all, rather than faking the number: that figure is computed
-- server-side from ledger entries, so there is nowhere else to put it. And the
-- 14-day clearing hold means no honest path (a real tip, a real sale) can
-- produce an AVAILABLE balance today — every genuine credit lands in "clearing".
--
-- Recipient is shpwkvr7jg (088f2023…), the account the screenshots are shot on,
-- which had $0.00 available and $5.58 clearing.

select public.ledger_post(
  'adjustment',
  jsonb_build_array(
    -- available_at in the PAST is the whole point: it skips the 14-day hold so
    -- the balance shows as available rather than clearing.
    jsonb_build_object('user', '088f2023-b99b-41c5-872c-034e4b8ee897',
                       'kind', 'earnings', 'amount_cents', 5800,
                       'available_at', now() - interval '1 day'),
    jsonb_build_object('user', null, 'kind', 'platform', 'amount_cents', -5800)),
  'manual',
  'demo:wallet-screenshot-2026-08-10',
  'DEMO BALANCE for App Store screenshot - reverse before launch'
) as transaction_id;

-- The external_id makes this idempotent: running the file twice posts once.

-- ─── Verify ─────────────────────────────────────────────────────────────────
select
  (select coalesce(sum(e.amount_cents), 0)
     from ledger_accounts a join ledger_entries e on e.account_id = a.id
    where a.user_id = '088f2023-b99b-41c5-872c-034e4b8ee897'
      and a.kind = 'earnings' and e.available_at <= now())    as available_cents,
  (select count(*) from public.ledger_verify())               as invariant_violations;
