-- Direct per-beat Apple/Google IAP for the shop, ALONGSIDE credits.
-- Run AFTER: ledger.sql, payouts.sql, shop.sql, shop_multi.sql, shop_credits.sql,
--            offer_expiry.sql, shop_stats.sql, shop_exclusivity_lock.sql (LAST, so
--            the FOR UPDATE trigger bodies win). Idempotent; safe to re-run.
-- ⚠️ MONEY CODE — do not run until reviewed. See docs/BEATS_IAP_PLAN.md.
--
-- WHY THIS EXISTS
-- Credits stay the "bonus" rail, but the PRIMARY way to buy a beat becomes a
-- one-tap Apple/Google purchase of a fixed-price product — no "top up credits
-- first" detour, and Apple shows the real tax-inclusive total up front. Apple IAP
-- only sells FIXED price points, so a sellable beat's price must be one of the 22
-- tiers in lib/pricing.ts; a price off the ladder stays credits-only.
--
-- SAME ECONOMICS AS A CREDIT-FUNDED SALE, so nothing downstream changes (payouts,
-- the 14-day hold and the wallet all read the same ledger):
--   credit-funded: funding(platform -price, buyer credits +price)
--                + purchase(buyer credits -price, seller earnings +payout,
--                           platform +fee)              → platform nets -payout
--   direct-IAP   : purchase(seller earnings +payout, platform +fee,
--                           platform -price)            → platform nets -payout
-- Same end state, no buyer-credits leg. Apple's cut is taken by Apple.
--
-- THE HARD PART: the RevenueCat webhook sees only (app_user_id, product_id,
-- event_id) — it CANNOT tell which listing was bought. So the client first calls
-- shop_begin_iap_order() to record an INTENT (which listing, which kind, at what
-- tier) and gets back an intent id + the product to buy; it tags the purchase with
-- that intent id (a RevenueCat subscriber attribute `laybellPendingOrder`); the
-- webhook reads it back and calls shop_deliver_paid_order(). Delivery resolves the
-- intent ONLY by that tag (scoped to the paying user) — never by a price guess,
-- because guessing is how a duplicate delivery could mint a second beat.
--
-- IDEMPOTENCY IS KEYED ON THE PROCESSOR EVENT, across every branch:
-- shop_iap_payments(source, event_id) makes the WHOLE delivery a no-op on a repeat,
-- and each ledger leg is also keyed on the event id. That payments row also RECORDS
-- the outcome (delivered vs credited) + the store txn ids, so a later REFUND can
-- reverse the right thing: revoke a delivered beat's file access, OR claw back
-- make-whole credits (absorbing if already spent — same as a refunded credit pack).
--
-- A buyer who pays but cannot be delivered to (sold out, untagged, a second charge,
-- a slot already taken by a credit sale) is always made whole with platform-funded
-- credits.

do $$
begin
  if not exists (select 1 from pg_proc where proname = 'shop_fee_rate') then
    raise exception 'run shop_credits.sql before shop_iap.sql';
  end if;
  if not exists (select 1 from pg_proc where proname = 'payout_hold_days') then
    raise exception 'run payouts.sql before shop_iap.sql';
  end if;
  -- The exclusivity guarantee rests on the precheck/delivery triggers taking a
  -- `select ... for update` on the listing. Those functions are (re)defined in
  -- several files; only shop_exclusivity_lock.sql carries the lock, and a later
  -- plain-SELECT redefinition (shop_stats.sql) silently removes it — the exact
  -- deploy drift AGENTS.md warns about. Refuse to install atop an unlocked
  -- definition: an IAP sale concurrent with a credit/free sale would double-sell.
  if not exists (select 1 from pg_proc where proname = 'shop_order_precheck'  and prosrc ilike '%for update%')
     or not exists (select 1 from pg_proc where proname = 'shop_order_delivered' and prosrc ilike '%for update%') then
    raise exception 'shop_order_precheck/shop_order_delivered must carry FOR UPDATE — run shop_exclusivity_lock.sql LAST (after shop_stats.sql/shop_multi.sql).';
  end if;
end $$;


-- ─── 1) Price tiers ─────────────────────────────────────────────────────────
-- Mirrored from lib/pricing.ts and the ITEM_PRODUCTS map in the revenuecat-webhook.
-- Keep all three in sync — a mismatch is a purchase that charges and never
-- delivers. (The store-side product PRICE is a 4th mirror the DB can't see; each
-- laybell_item_N product in ASC/Play MUST be priced exactly $N/100 — a
-- misconfiguration would deliver tier value for a smaller charge.)
create or replace function public.shop_price_tiers()
returns int[] language sql immutable as $$
  select array[
    499, 999, 1499, 1999, 2499, 2999, 3499, 3999, 4999, 5999, 6999, 7999,
    9999, 12999, 14999, 19999, 24999, 29999, 39999, 49999, 69999, 99999
  ]
$$;

create or replace function public.shop_is_price_tier(p_cents int)
returns boolean language sql immutable as $$
  select p_cents = any (public.shop_price_tiers())
$$;


-- ─── 2) Intents + processed-payments ────────────────────────────────────────
-- An intent is one purchase attempt: the durable link from a tap on "Buy" to the
-- webhook that later delivers it. NOT the order — the order is created only when
-- payment lands (like a credit sale), so this never collides with the
-- one-order-per-(listing,buyer,kind) index.
create table if not exists public.shop_iap_intents (
  id            uuid primary key default gen_random_uuid(),
  buyer_id      uuid not null references auth.users(id) on delete cascade,
  listing_id    uuid not null references public.shop_listings(id) on delete cascade,
  kind          text not null check (kind in ('sell', 'lease')),
  price_cents   int  not null check (price_cents > 0),
  product_id    text not null,
  status        text not null default 'pending'
                  check (status in ('pending', 'delivered', 'failed', 'expired')),
  order_id      uuid references public.shop_orders(id),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default (now() + interval '20 minutes')
);

create index if not exists shop_iap_intents_buyer_idx
  on public.shop_iap_intents (buyer_id, created_at desc);

alter table public.shop_iap_intents enable row level security;
-- Read-only for the buyer (the client polls for delivery). Every write goes
-- through the SECURITY DEFINER RPCs below, so there is no insert/update policy.
drop policy if exists "Buyers read their own IAP intents" on public.shop_iap_intents;
create policy "Buyers read their own IAP intents"
  on public.shop_iap_intents for select using (buyer_id = auth.uid());

-- ONE economic effect per processor event, across every delivery branch, AND the
-- record a refund reads to reverse the right thing. The unique (source, event_id)
-- makes a RevenueCat retry a true no-op even when it would take a different branch.
-- Written in the same transaction as the effect, so it rolls back with a failed
-- delivery and a genuine retry can re-process.
create table if not exists public.shop_iap_payments (
  id            uuid primary key default gen_random_uuid(),
  source        text not null check (source in ('apple_iap', 'google_play')),
  event_id      text not null,
  buyer_id      uuid references auth.users(id) on delete set null,
  paid_cents    int,
  -- Store transaction ids, so a later refund event (which carries transaction_id
  -- and/or original_transaction_id) can find this purchase.
  store_txn_id      text,
  store_orig_txn_id text,
  -- The raw processor app_user_id as the webhook saw it. It may be stale/transferred
  -- or anonymous (NOT a valid auth.users id), so it has NO foreign key — it is only
  -- for audit. The authoritative buyer is buyer_id, taken from the intent.
  store_app_user_id text,
  -- What this payment did: 'delivered' a beat (→ order_id) or 'credited' the buyer
  -- (make-whole). Null only for the transient window before the outcome is set,
  -- which never commits (every branch sets it before returning).
  outcome       text check (outcome in ('delivered', 'credited')),
  order_id      uuid references public.shop_orders(id),
  created_at    timestamptz not null default now(),
  unique (source, event_id)
);
create index if not exists shop_iap_payments_txn_idx
  on public.shop_iap_payments (store_txn_id) where store_txn_id is not null;
create index if not exists shop_iap_payments_origtxn_idx
  on public.shop_iap_payments (store_orig_txn_id) where store_orig_txn_id is not null;
-- Add on re-run over an already-deployed table.
alter table public.shop_iap_payments add column if not exists store_app_user_id text;
alter table public.shop_iap_payments enable row level security;  -- service-role only; no policy


-- ─── 3) Begin ───────────────────────────────────────────────────────────────
-- Called by the buyer. Validates the listing/kind, confirms the price is a tier,
-- records (or refreshes) an intent, and returns the product id to purchase. Moves
-- no money and reserves nothing — exclusivity is resolved at delivery, under the
-- same listing lock a credit sale takes.
create or replace function public.shop_begin_iap_order(p_listing_id uuid, p_kind text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_buyer  uuid := auth.uid();
  l        public.shop_listings%rowtype;
  v_sell boolean; v_lease boolean;
  v_price  int;
  v_intent public.shop_iap_intents%rowtype;
begin
  if v_buyer is null then raise exception 'not_signed_in'; end if;
  -- free = instant (no payment); offer = buyer-named price (credits-only). IAP is
  -- for the two fixed-price kinds.
  if p_kind not in ('sell', 'lease') then raise exception 'bad_kind'; end if;

  select * into l from public.shop_listings where id = p_listing_id;
  if l.id is null then raise exception 'listing_not_found'; end if;
  if l.status <> 'active' then raise exception 'listing_not_available'; end if;
  if l.user_id = v_buyer then raise exception 'cannot_buy_own'; end if;

  -- Effective deal types + price, mirroring shop_order_precheck.
  v_sell  := l.sell_enabled  or (not (l.sell_enabled or l.lease_enabled or l.free_enabled) and l.license = 'exclusive');
  v_lease := l.lease_enabled or (not (l.sell_enabled or l.lease_enabled or l.free_enabled) and l.license = 'nonexclusive');

  if p_kind = 'sell' then
    if not v_sell then raise exception 'kind_not_available'; end if;
    v_price := case when l.sell_enabled then l.sell_price_cents else l.price_cents end;
  else
    if not v_lease then raise exception 'kind_not_available'; end if;
    v_price := case when l.lease_enabled then l.lease_price_cents else l.price_cents end;
  end if;

  if v_price is null or v_price <= 0 then raise exception 'price_unset'; end if;
  -- Off-ladder price → no IAP product exists → the client falls back to credits.
  if not public.shop_is_price_tier(v_price) then raise exception 'price_not_tier'; end if;

  -- Already own it? (one delivered order per listing+buyer+kind)
  if exists (
    select 1 from public.shop_orders o
     where o.listing_id = p_listing_id and o.buyer_id = v_buyer
       and coalesce(o.kind, 'legacy') = p_kind and o.status = 'delivered'
  ) then
    raise exception 'already_purchased';
  end if;

  -- Reuse a fresh pending intent for the same target rather than piling them up.
  -- Failed/expired/delivered intents are never reused, so a buyer who hit a
  -- mismatch simply gets a clean new intent on the next tap.
  select * into v_intent from public.shop_iap_intents
   where buyer_id = v_buyer and listing_id = p_listing_id and kind = p_kind
     and status = 'pending' and expires_at > now()
   order by created_at desc limit 1;

  if v_intent.id is not null then
    update public.shop_iap_intents
       set price_cents = v_price,
           product_id  = 'laybell_item_' || v_price,
           expires_at  = now() + interval '20 minutes'
     where id = v_intent.id
     returning * into v_intent;
  else
    insert into public.shop_iap_intents (buyer_id, listing_id, kind, price_cents, product_id)
      values (v_buyer, p_listing_id, p_kind, v_price, 'laybell_item_' || v_price)
      returning * into v_intent;
  end if;

  return jsonb_build_object('ok', true, 'intent_id', v_intent.id,
                            'product_id', v_intent.product_id, 'price_cents', v_price);
end $$;

grant execute on function public.shop_begin_iap_order(uuid, text) to authenticated;


-- ─── 4) Deliver ─────────────────────────────────────────────────────────────
-- Called ONLY by the revenuecat-webhook (service role). Delivers a paid beat, or
-- makes the buyer whole in credits when it can't, recording the outcome on the
-- payment row. Reuses the precheck + delivery triggers so the exclusivity FOR
-- UPDATE lock and the auto-decline behave EXACTLY as for a credit sale. Never
-- raises on an expected business outcome — it no-ops a duplicate event or returns
-- {ok:false} so the webhook 2xxs and RevenueCat doesn't retry.
create or replace function public.shop_deliver_paid_order(
  p_buyer       uuid,
  p_paid_cents  int,
  p_source      text,
  p_external_id text,
  p_txn_id      text default null,
  p_orig_txn_id text default null,
  p_intent_id   uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pay_id   uuid;
  v_intent   public.shop_iap_intents%rowtype;
  v_buyer    uuid;
  l          public.shop_listings%rowtype;
  v_sell boolean; v_lease boolean;
  v_price    int;
  v_existing public.shop_orders%rowtype;
  v_order    public.shop_orders%rowtype;
  v_fee      bigint;
  v_payout   bigint;
  v_tx       uuid;
begin
  if p_source not in ('apple_iap', 'google_play') then raise exception 'bad_source'; end if;
  if p_external_id is null then raise exception 'no_event_id'; end if;

  -- (1) Resolve the intent by its TAG — the server-authenticated source of truth for
  -- WHO is buying and WHICH listing. The processor's app_user_id (p_buyer) is NOT
  -- trusted for identity: Apple/Google account transfers, re-installs and anonymous
  -- ids can make it differ from — or not even be — the real buyer. The buyer comes
  -- from the intent. No price-only fallback (that could cross buyers and mint); a
  -- missing/unknown tag is recorded for manual follow-up, never guessed.
  if p_intent_id is not null then
    select * into v_intent from public.shop_iap_intents where id = p_intent_id for update;
  end if;
  if v_intent.id is null then
    insert into public.shop_iap_payments (source, event_id, paid_cents, store_txn_id, store_orig_txn_id, store_app_user_id)
      values (p_source, p_external_id, p_paid_cents, p_txn_id, p_orig_txn_id, p_buyer::text)
      on conflict (source, event_id) do nothing;
    return jsonb_build_object('ok', false, 'reason', 'no_tag');
  end if;

  v_buyer := v_intent.buyer_id;   -- authoritative; always a valid auth.users id

  -- (2) Payment-level idempotency. ONE economic effect per processor event, across
  -- every branch below. A RevenueCat retry conflicts here and returns having done
  -- nothing a second time. Atomic with the work below; the processor txn + user ids
  -- are recorded for refunds and audit (store_app_user_id has no FK — it may be stale).
  insert into public.shop_iap_payments (source, event_id, buyer_id, paid_cents, store_txn_id, store_orig_txn_id, store_app_user_id)
    values (p_source, p_external_id, v_buyer, p_paid_cents, p_txn_id, p_orig_txn_id, p_buyer::text)
    on conflict (source, event_id) do nothing
    returning id into v_pay_id;
  if v_pay_id is null then
    return jsonb_build_object('ok', true, 'idempotent', true, 'reason', 'duplicate_event');
  end if;

  -- (3) The intent is already settled → this is a SECOND real payment for it (e.g.
  -- a double tap reusing one intent). NOT a retry (caught at step 0), so the new
  -- charge is made whole, not silently acked.
  if v_intent.status <> 'pending' then
    perform public.shop_iap_make_whole(v_pay_id, v_buyer, p_paid_cents, p_source, p_external_id,
                                       'Duplicate beat purchase — credited');
    return jsonb_build_object('ok', false, 'reason', 'intent_settled', 'credited', p_paid_cents);
  end if;

  -- (4) The product actually bought must be the tier we issued for this intent.
  -- `is distinct from` (not `<>`) so a null paid amount fails CLOSED — it counts as
  -- a mismatch and is made whole, rather than `null <> X` evaluating to null and
  -- silently delivering an unvalidated charge. (The webhook always passes a tier
  -- from ITEM_PRODUCTS, so null is a can't-happen guard; match line (5)'s style.)
  if p_paid_cents is distinct from v_intent.price_cents then
    perform public.shop_iap_make_whole(v_pay_id, v_buyer, p_paid_cents, p_source, p_external_id,
                                       'Beat purchase price mismatch — credited');
    update public.shop_iap_intents set status = 'failed' where id = v_intent.id;
    return jsonb_build_object('ok', false, 'reason', 'price_mismatch', 'credited', p_paid_cents);
  end if;

  -- (5) Lock the listing and re-resolve. Only an ACTIVE listing still at the SAME
  -- tier price (and still offering this kind) can be delivered. Holding this lock
  -- serializes two buyers of the same exclusive beat: the loser wakes, reads
  -- 'sold', and takes the make-whole path instead of double-selling it.
  select * into l from public.shop_listings where id = v_intent.listing_id for update;
  if l.id is not null then
    v_sell  := l.sell_enabled  or (not (l.sell_enabled or l.lease_enabled or l.free_enabled) and l.license = 'exclusive');
    v_lease := l.lease_enabled or (not (l.sell_enabled or l.lease_enabled or l.free_enabled) and l.license = 'nonexclusive');
    if v_intent.kind = 'sell' then
      v_price := case when l.sell_enabled then l.sell_price_cents else l.price_cents end;
    else
      v_price := case when l.lease_enabled then l.lease_price_cents else l.price_cents end;
    end if;
  end if;

  if l.id is null or l.status <> 'active'
     or v_price is distinct from v_intent.price_cents
     or (v_intent.kind = 'sell'  and not v_sell)
     or (v_intent.kind = 'lease' and not v_lease) then
    perform public.shop_iap_make_whole(v_pay_id, v_buyer, p_paid_cents, p_source, p_external_id,
                                       'Beat no longer available — purchase credited');
    update public.shop_iap_intents set status = 'failed' where id = v_intent.id;
    return jsonb_build_object('ok', false, 'reason', 'unavailable', 'credited', p_paid_cents);
  end if;

  -- (6) One order per (listing, buyer, kind). Any pre-existing order means the slot
  -- is taken — by a different rail (this event's own order can't exist yet, and a
  -- retry was caught at step 0), e.g. the buyer also bought this lease with credits
  -- before the webhook landed. The item is already theirs, so make the IAP charge
  -- whole rather than silently acking a second charge for nothing.
  select * into v_existing from public.shop_orders
    where listing_id = v_intent.listing_id and buyer_id = v_buyer
      and coalesce(kind, 'legacy') = v_intent.kind
    limit 1;
  if v_existing.id is not null then
    perform public.shop_iap_make_whole(v_pay_id, v_buyer, p_paid_cents, p_source, p_external_id,
                                       'Beat already owned — purchase credited');
    update public.shop_iap_intents set status = 'failed' where id = v_intent.id;
    return jsonb_build_object('ok', false, 'reason', 'order_slot_taken', 'credited', p_paid_cents);
  end if;

  v_fee    := round(v_intent.price_cents * public.shop_fee_rate());
  v_payout := v_intent.price_cents - v_fee;

  -- (7) Deliver. Create the order (precheck re-validates + re-prices under the lock
  -- we hold), post the sale keyed on the processor event, then flip to delivered
  -- (the delivery trigger marks an exclusive listing sold and auto-declines pending
  -- requests — identical to a credit sale).
  -- Set the authoritative fee_cents HERE at insert, not for the first time in the
  -- delivery update below. shop_orders_guard() raises protected_column when an UPDATE
  -- moves fee_cents to a *different* value (it would have, from the 0 default). The
  -- guard is INSERT-exempt, and precheck only rewrites fee_cents on the free-claim
  -- branch (not sell/lease) — so the fee lands cleanly here, and the delivery update's
  -- `fee_cents = v_fee` is then setting the column to the value it already holds, which
  -- `is distinct from` treats as no change, so the guard passes without any bypass.
  insert into public.shop_orders (listing_id, buyer_id, seller_id, kind, price_cents, fee_cents, status)
    values (v_intent.listing_id, v_buyer, l.user_id, v_intent.kind, v_intent.price_cents, v_fee, 'requested')
    returning * into v_order;

  v_tx := public.ledger_post('purchase',
    jsonb_build_array(
      jsonb_build_object('user', l.user_id, 'kind', 'earnings', 'amount_cents', v_payout,
                         'available_at', now() + (public.payout_hold_days() || ' days')::interval),
      jsonb_build_object('user', null,      'kind', 'platform', 'amount_cents', v_fee),
      jsonb_build_object('user', null,      'kind', 'platform', 'amount_cents', -v_intent.price_cents)),
    p_source, p_external_id, 'Beat purchase (direct IAP)');

  update public.shop_orders
     set status = 'delivered', delivered_at = now(), fee_cents = v_fee
   where id = v_order.id;

  update public.shop_iap_intents
     set status = 'delivered', order_id = v_order.id
   where id = v_intent.id;

  update public.shop_iap_payments
     set outcome = 'delivered', order_id = v_order.id
   where id = v_pay_id;

  return jsonb_build_object('ok', true, 'delivered', true, 'order_id', v_order.id,
                            'seller_cents', v_payout, 'fee_cents', v_fee, 'transaction_id', v_tx);
end $$;

-- Make the buyer whole in platform-funded credits, keyed on the processor event,
-- and record it on the payment row so a refund can claw it back. Internal to the
-- deliver RPC (same transaction).
create or replace function public.shop_iap_make_whole(
  p_pay_id uuid, p_buyer uuid, p_paid_cents int, p_source text, p_external_id text, p_memo text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Leg order is lock order (ledger_post locks each account as it posts). Put the
  -- user (credits) leg before the platform leg, matching shop_buy_with_credits, so
  -- a concurrent same-buyer credit spend can't lock-order-invert against this.
  perform public.ledger_post('refund',
    jsonb_build_array(
      jsonb_build_object('user', p_buyer, 'kind', 'credits',  'amount_cents',  p_paid_cents),
      jsonb_build_object('user', null,    'kind', 'platform', 'amount_cents', -p_paid_cents)),
    p_source, p_external_id, p_memo);
  update public.shop_iap_payments set outcome = 'credited' where id = p_pay_id;
end $$;

-- Invariant 5 (ledger.sql): nothing client-side may deliver. Service role only.
revoke all on function public.shop_deliver_paid_order(uuid, int, text, text, text, text, uuid) from public;
revoke all on function public.shop_deliver_paid_order(uuid, int, text, text, text, text, uuid) from authenticated;
revoke all on function public.shop_iap_make_whole(uuid, uuid, int, text, text, text) from public;
revoke all on function public.shop_iap_make_whole(uuid, uuid, int, text, text, text) from authenticated;


-- ─── 5) Poll ────────────────────────────────────────────────────────────────
-- The client calls this after the store returns to show "unlocking…" until the
-- webhook has delivered (or credited back) the purchase.
create or replace function public.shop_poll_iap_order(p_intent_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_intent public.shop_iap_intents%rowtype;
begin
  select * into v_intent from public.shop_iap_intents where id = p_intent_id;
  -- `is distinct from` so the ownership check fails CLOSED: a null auth.uid()
  -- (no/invalid JWT) makes `buyer_id <> auth.uid()` evaluate to null and NOT raise,
  -- which would leak the intent's status to an unauthenticated caller. anon is
  -- already revoked below, but this keeps the access check correct on its own.
  if v_intent.id is null or v_intent.buyer_id is distinct from auth.uid() then
    raise exception 'not_found';
  end if;
  return jsonb_build_object(
    'status', v_intent.status,
    'order_id', v_intent.order_id,
    'delivered', v_intent.status = 'delivered',
    'credited', v_intent.status = 'failed'   -- a failed delivery was credited back
  );
end $$;

grant execute on function public.shop_poll_iap_order(uuid) to authenticated;


-- ─── 6) Refund ──────────────────────────────────────────────────────────────
-- Matched to the purchase via the stored txn ids (a refund event may carry the
-- purchase's transaction_id OR its original_transaction_id), scoped to the store.
-- Then, per what that payment did:
--   delivered → v1 ABSORB (docs/BEATS_IAP_PLAN.md): do NOT claw the seller back
--               (the ledger refuses a negative user balance once they've withdrawn,
--               and clawback is deferred); just flip the order to 'refunded' so the
--               buyer loses file access and the seller's counts drop.
--   credited  → reverse the make-whole credits, exactly as a refunded credit pack
--               does — absorbing if the buyer already spent them (the ledger refuses
--               to drive credits negative, which surfaces as refund_failed).
create or replace function public.shop_mark_iap_refunded(
  p_txn_id text, p_orig_txn_id text, p_source text, p_refund_event_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_pay public.shop_iap_payments%rowtype;
begin
  if p_txn_id is null and p_orig_txn_id is null then
    return jsonb_build_object('ok', false, 'reason', 'no_txn');
  end if;
  select * into v_pay from public.shop_iap_payments
    where source = p_source
      and ( store_txn_id = p_txn_id or store_txn_id = p_orig_txn_id
         or store_orig_txn_id = p_txn_id or store_orig_txn_id = p_orig_txn_id )
    order by created_at desc limit 1;
  if v_pay.id is null then
    -- A known-item refund matching nothing is a real support case (the buyer may
    -- keep file access or credits), surfaced in the webhook logs.
    return jsonb_build_object('ok', false, 'reason', 'order_not_found');
  end if;

  if v_pay.outcome = 'delivered' and v_pay.order_id is not null then
    update public.shop_orders
       set status = 'refunded', refunded_at = now()
     where id = v_pay.order_id and status = 'delivered';
    return jsonb_build_object('ok', true, 'revoked', true, 'order_id', v_pay.order_id);

  elsif v_pay.outcome = 'credited' and v_pay.buyer_id is not null then
    -- Claw back the make-whole credits. Raises (→ webhook refund_failed) if already
    -- spent; idempotent on the refund event id so a retried refund is a no-op.
    perform public.ledger_post('refund',
      jsonb_build_array(
        jsonb_build_object('user', v_pay.buyer_id, 'kind', 'credits',  'amount_cents', -v_pay.paid_cents),
        jsonb_build_object('user', null,           'kind', 'platform', 'amount_cents',  v_pay.paid_cents)),
      p_source, 'refund:' || p_refund_event_id, 'Beat make-whole credit refunded');
    return jsonb_build_object('ok', true, 'reversed_cents', v_pay.paid_cents);
  end if;

  return jsonb_build_object('ok', true, 'noop', true);
end $$;

revoke all on function public.shop_mark_iap_refunded(text, text, text, text) from public;
revoke all on function public.shop_mark_iap_refunded(text, text, text, text) from authenticated;


-- ─── 7) Intent sweep (optional cron) ────────────────────────────────────────
-- Hygiene: flip abandoned pending intents to 'expired'. Not security-critical
-- (delivery resolves intents only by their tag, never by scanning pending rows),
-- but it keeps the table tidy. Schedule hourly via pg_cron if desired.
create or replace function public.shop_sweep_iap_intents()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_n int;
begin
  update public.shop_iap_intents set status = 'expired'
    where status = 'pending' and expires_at < now();
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.shop_sweep_iap_intents() from public;
revoke all on function public.shop_sweep_iap_intents() from authenticated;

-- ─── Revoke anon, BY NAME (the load-bearing one) ────────────────────────────
-- Supabase's bootstrap runs `alter default privileges ... grant all on functions
-- to postgres, anon, authenticated, service_role`, so EVERY new function in
-- `public` is created with an explicit EXECUTE grant to `anon` — and
-- `revoke ... from public`/`from authenticated` does NOT remove it (see the same
-- warning in money_hardening_2026-07-29.sql). The anon key ships inside the app
-- bundle, so without these revokes shop_deliver_paid_order / shop_iap_make_whole
-- are callable with NO JWT -> anyone can mint withdrawable earnings and credits.
-- Revoke anon by name on every function this file creates. Pre-flight (all false):
--   select p.proname, has_function_privilege('anon', p.oid, 'execute')
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname='public' and p.proname like 'shop_%iap%';
revoke all on function public.shop_price_tiers()                                             from anon;
revoke all on function public.shop_is_price_tier(int)                                        from anon;
-- begin/poll keep their explicit `grant to authenticated` (the client calls them)
-- but must also drop the default PUBLIC execute grant — anon reaches a function
-- through PUBLIC too, so revoking anon alone leaves the PUBLIC path open.
revoke all on function public.shop_begin_iap_order(uuid, text)                               from public, anon;
revoke all on function public.shop_deliver_paid_order(uuid, int, text, text, text, text, uuid) from anon;
revoke all on function public.shop_iap_make_whole(uuid, uuid, int, text, text, text)         from anon;
revoke all on function public.shop_poll_iap_order(uuid)                                       from public, anon;
revoke all on function public.shop_mark_iap_refunded(text, text, text, text)                 from anon;
revoke all on function public.shop_sweep_iap_intents()                                       from anon;


-- ─── Checking it ────────────────────────────────────────────────────────────
--   Exactly one ledger tx per processor event (should return NO rows):
--     select source, external_id, count(*) from public.ledger_transactions
--      where source in ('apple_iap','google_play')
--      group by 1,2 having count(*) > 1;
--
--   Every payment recorded an outcome (should return NO committed nulls):
--     select count(*) from public.shop_iap_payments where outcome is null;
--
--   No listing IAP-sold twice (should return NO rows):
--     select i.listing_id, count(*) from public.shop_iap_intents i
--      where i.status = 'delivered' and i.kind = 'sell' group by 1 having count(*) > 1;
--
-- Rollback:
--   drop function if exists public.shop_sweep_iap_intents(),
--     public.shop_mark_iap_refunded(text,text,text,text), public.shop_poll_iap_order(uuid),
--     public.shop_iap_make_whole(uuid,uuid,int,text,text,text),
--     public.shop_deliver_paid_order(uuid,int,text,text,text,text,uuid),
--     public.shop_begin_iap_order(uuid,text),
--     public.shop_is_price_tier(int), public.shop_price_tiers();
--   drop table if exists public.shop_iap_payments, public.shop_iap_intents;
