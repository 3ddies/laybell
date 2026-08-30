-- Undo the $456.00 wallet screenshot balance. RUN AS SOON AS THE SHOT IS TAKEN.
--
--   npx supabase db query --linked -f supabase/sql/_DEMO_wallet_456_REVERSE.sql
--
-- Two different kinds of undo, because the two halves are different kinds of
-- record.
--
-- The LEDGER is append-only by constraint, so its undo is a mirror transaction —
-- the original stays visible and the net is zero, which is how double-entry has
-- always corrected a mistake.
--
-- The donations, orders, listing and stream are ordinary rows and are deleted
-- outright, by their fixed ids, so nothing else can be caught in it.
--
-- Safe to run twice, and safe to run if the demo was never applied: the ledger
-- legs still balance, external_id keeps it to one posting, and the deletes match
-- nothing.

delete from public.shop_orders   where id::text like 'dede0000-0000-4000-8000-00000000002%';
delete from public.shop_listings where id = 'dede0000-0000-4000-8000-000000000002';
delete from public.donations     where id::text like 'dede0000-0000-4000-8000-00000000001%';
delete from public.live_streams  where id = 'dede0000-0000-4000-8000-000000000001';

select public.ledger_post(
  'adjustment',
  jsonb_build_array(
    jsonb_build_object('user', (select id from public.profiles where lower(username) = '3ddie'),
                       'kind', 'earnings', 'amount_cents', -45600,
                       'available_at', now() - interval '1 day'),
    jsonb_build_object('user', null, 'kind', 'platform', 'amount_cents', 45600)),
  'manual',
  'demo:wallet-456-screenshot:reversal',
  'Reverses the store-screenshot demo balance'
) as transaction_id;

-- ─── Verify: the demo money is gone and nothing else moved ──────────────────
-- All four counts were 0 before the demo was applied, so 0 is the proof that
-- the undo caught everything rather than most of it.
select
  (select coalesce(sum(e.amount_cents), 0)
     from ledger_accounts a join ledger_entries e on e.account_id = a.id
     join public.profiles p on p.id = a.user_id
    where lower(p.username) = '3ddie' and a.kind = 'earnings'
      and e.available_at <= now())                    as available_cents_want_0,
  (select count(*) from public.donations)             as donations_want_0,
  (select count(*) from public.shop_orders)           as shop_orders_want_0,
  (select count(*) from public.shop_listings
     where id = 'dede0000-0000-4000-8000-000000000002') as demo_listing_want_0,
  (select count(*) from public.live_streams)          as live_streams_want_0,
  (select count(*) from public.ledger_verify())       as invariant_violations_want_0,
  (select coalesce(sum(amount_cents), 0) from public.ledger_entries) as global_sum_want_0;
