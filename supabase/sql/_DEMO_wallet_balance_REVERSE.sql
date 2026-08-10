-- Undo the demo wallet balance. Run this BEFORE LAUNCH.
--
--   npx supabase db query --linked -f supabase/sql/_DEMO_wallet_balance_REVERSE.sql
--
-- A mirror transaction, not a delete: ledger entries are append-only by
-- constraint, and reversing rather than erasing is how double-entry has always
-- corrected a mistake — the original stays visible and the net is zero.
--
-- Safe to run even if the demo was never applied: the legs still balance, and
-- the external_id keeps it to exactly one posting.

select public.ledger_post(
  'adjustment',
  jsonb_build_array(
    jsonb_build_object('user', '088f2023-b99b-41c5-872c-034e4b8ee897',
                       'kind', 'earnings', 'amount_cents', -5800,
                       'available_at', now() - interval '1 day'),
    jsonb_build_object('user', null, 'kind', 'platform', 'amount_cents', 5800)),
  'manual',
  'demo:wallet-screenshot-2026-08-10:reversal',
  'Reverses the App Store screenshot demo balance'
) as transaction_id;

-- ─── Verify: the demo money is gone and the ledger still balances ───────────
select
  (select coalesce(sum(e.amount_cents), 0)
     from ledger_accounts a join ledger_entries e on e.account_id = a.id
    where a.user_id = '088f2023-b99b-41c5-872c-034e4b8ee897'
      and a.kind = 'earnings' and e.available_at <= now())  as available_cents_should_be_0,
  (select count(*) from public.ledger_verify())             as invariant_violations;
