-- DEMO MONEY — $456.00 for the wallet screenshot. NOT A REAL BALANCE.
--
--   npx supabase db query --linked -f supabase/sql/_DEMO_wallet_456.sql
--   npx supabase db query --linked -f supabase/sql/_DEMO_wallet_456_REVERSE.sql   <-- UNDO
--
-- ⚠️ REVERSE THIS THE MOMENT THE SCREENSHOT IS TAKEN. The headline figure is
-- earnings.availableCents — the WITHDRAWABLE balance — so this does not paint a
-- number on a screen, it makes $456.00 genuinely eligible for payout. With
-- Stripe live and payoutsAvailable() on, "Transfer to bank" would move four
-- hundred and fifty-six real dollars against value that never existed. The $58
-- version of this had to be chased down on launch day; this one is eight times
-- larger.
--
-- WHY IT TAKES THREE TABLES AND NOT ONE. The wallet's headline comes from the
-- LEDGER, but the two lines under it — "from tips" and "from shop" — do not.
-- They come from donation_earnings() and delivered_earnings(), which read the
-- donations and shop_orders tables directly (see lib/wallet.ts: the derived
-- figures "stay in the payload purely as a breakdown label"). A ledger-only
-- balance therefore renders as "$456.00 / $0.00 from tips / $0.00 from shop" —
-- inside the same green card, so it cannot be cropped out, and it reads as a
-- bug rather than a balance.
--
-- SPLIT: 2/3 tips, 1/3 shop.
--   tips  30400 = 12000 + 8000 + 6400 + 4000   (payouts, DERIVED by the guard)
--   shop  15200 = round(21714 * 0.70)                (one delivered order)
--   total 45600
-- The shop figure is DERIVED, not stored: delivered_earnings() computes
-- round(price_cents * (1 - shop_fee_rate())), and shop_fee_rate() is 0.30 —
-- so the prices are worked backwards from the payout, never the other way.
--
-- COUNTERPARTIES are Eddie's own accounts. The tipper and buyer is
-- @laybellreview; nothing here invents a stranger's financial activity.
--
-- FIXED UUIDs on purpose: the reverse file deletes exactly these rows and
-- nothing else, and re-running this file cannot double up.

do $$
declare
  v_eddie  uuid;
  v_review uuid;
  v_stream uuid := 'dede0000-0000-4000-8000-000000000001';
  v_listing uuid := 'dede0000-0000-4000-8000-000000000002';
begin
  select id into v_eddie  from public.profiles where lower(username) = '3ddie';
  select id into v_review from public.profiles where lower(username) = 'laybellreview';
  if v_eddie is null or v_review is null then
    raise exception 'Expected @3ddie and @laybellreview to exist.';
  end if;

  -- A finished broadcast for the tips to hang off. donations.stream_id is NOT
  -- NULL and references live_streams, so a tip cannot exist without one.
  -- status 'ended' so it never appears on the Live tab and the every-minute
  -- reap-stale-lives cron has nothing to do with it.
  insert into public.live_streams (id, user_id, cf_input_uid, playback_url, status, title)
  values (v_stream, v_eddie, 'demo-screenshot-input', 'https://example.invalid/demo.m3u8',
          'ended', 'Demo session (screenshot)')
  on conflict (id) do nothing;

  -- Tips. ONLY amount_cents is supplied, because donation_guard overwrites the
  -- fee, the tax and the payout on every insert — passing a payout and watching
  -- it be silently replaced is how the first attempt produced $231.31 instead of
  -- $304.00. The guard computes fee = round(amount * 0.30) for a Premium host
  -- and payout = amount - fee, so these amounts are worked BACKWARDS from the
  -- payouts we want:
  --   17143 -> 12000    11429 -> 8000    9143 -> 6400    5714 -> 4000
  -- Deleted first so the file corrects itself when re-run; ON CONFLICT would
  -- leave wrong rows in place.
  delete from public.donations where id::text like 'dede0000-0000-4000-8000-00000000001%';
  insert into public.donations
    (id, donor_id, streamer_id, stream_id, amount_cents, provider, status)
  select
    ('dede0000-0000-4000-8000-00000000001' || n)::uuid,
    v_review, v_eddie, v_stream, amt, 'simulated', 'succeeded'
  from (values (1, 17143), (2, 11429), (3, 9143), (4, 5714)) as t(n, amt);

  -- A listing for the orders to reference (listing_id is NOT NULL).
  insert into public.shop_listings (id, user_id, title)
  values (v_listing, v_eddie, 'Demo beat (screenshot)')
  on conflict (id) do nothing;

  -- ONE sale, not two. shop_orders_listing_buyer_kind_uq allows a buyer exactly
  -- one purchase of a given listing, which is right — and two demo rows for the
  -- same listing and buyer collided with each other on the first attempt. A
  -- second sale would need a second listing, which is more fabricated data for
  -- no gain: the wallet shows the total, never the order count.
  --
  -- Inserted ALREADY delivered. shop_orders_delivered is a BEFORE UPDATE
  -- trigger, so nothing fires on insert and no buyer is notified.
  --
  -- 21714 * 0.70 = 15199.8, and delivered_earnings() rounds per order, so this
  -- lands on exactly 15200.
  insert into public.shop_orders
    (id, listing_id, buyer_id, seller_id, status, price_cents, fee_cents, delivered_at)
  values ('dede0000-0000-4000-8000-000000000021',
          v_listing, v_review, v_eddie, 'delivered', 21714, 6514, now() - interval '3 days')
  on conflict (id) do nothing;
end $$;

-- The withdrawable balance itself. available_at in the PAST skips the 14-day
-- clearing hold, which is the only reason this cannot be done with honest rows:
-- every genuine credit lands in "clearing" and would show as held, not
-- available. external_id makes it idempotent.
select public.ledger_post(
  'adjustment',
  jsonb_build_array(
    jsonb_build_object('user', (select id from public.profiles where lower(username) = '3ddie'),
                       'kind', 'earnings', 'amount_cents', 45600,
                       'available_at', now() - interval '1 day'),
    jsonb_build_object('user', null, 'kind', 'platform', 'amount_cents', -45600)),
  'manual',
  'demo:wallet-456-screenshot',
  'DEMO BALANCE for the store screenshot - REVERSE IMMEDIATELY'
) as transaction_id;

-- ─── Verify: every number the screenshot will show, asserted ────────────────
select
  (select coalesce(sum(e.amount_cents), 0)
     from ledger_accounts a join ledger_entries e on e.account_id = a.id
     join public.profiles p on p.id = a.user_id
    where lower(p.username) = '3ddie' and a.kind = 'earnings'
      and e.available_at <= now())                        as available_cents_want_45600,
  (select coalesce(sum(streamer_payout_cents), 0) from public.donations d
     join public.profiles p on p.id = d.streamer_id
    where lower(p.username) = '3ddie' and d.status = 'succeeded')
                                                          as tips_cents_want_30400,
  (select coalesce(sum(round(price_cents * (1 - public.shop_fee_rate()))), 0)
     from public.shop_orders o join public.profiles p on p.id = o.seller_id
    where lower(p.username) = '3ddie' and o.status = 'delivered')
                                                          as shop_cents_want_15200,
  (select count(*) from public.ledger_verify())           as invariant_violations_want_0,
  (select coalesce(sum(amount_cents), 0) from public.ledger_entries)
                                                          as global_sum_want_0;
