-- Direct card checkout for the shop via STRIPE (web only), ALONGSIDE credits + IAP.
-- Run AFTER: ledger.sql, payouts.sql, shop.sql, shop_multi.sql, shop_credits.sql,
--            offer_expiry.sql, shop_stats.sql, shop_exclusivity_lock.sql (LAST, so
--            the FOR UPDATE trigger bodies win), shop_iap.sql. Idempotent; re-runnable.
-- ⚠️ MONEY CODE — DO NOT RUN until reviewed. Built on the web-payments branch.
--
-- WHY THIS EXISTS
-- The web can't use Apple/Google IAP, so a buyer on laybell-web buys a beat with a
-- card through Stripe Checkout. Economically it is IDENTICAL to a direct-IAP sale
-- (shop_iap.sql) — Stripe is just another funding SOURCE into the same ledger, which
-- is exactly the design ledger.sql was built around (it already allows source
-- 'stripe'). Nothing downstream changes: the same order, the same 70/30 split, the
-- same payout hold, the same wallet, the same signed-URL delivery.
--
--   direct-Stripe: purchase(seller earnings +payout, platform +fee, platform -price)
--                                                              → platform nets -payout
-- Same end state as a credit- or IAP-funded sale, no buyer-credits leg. Stripe's cut
-- is taken by Stripe off-ledger.
--
-- THE FLOW (mirrors IAP's begin → deliver → poll, with Stripe as the processor):
--   1. web client → edge fn `stripe-checkout` (with the buyer's JWT)
--   2. that fn calls shop_begin_stripe_order() AS THE BUYER → validates + records an
--      INTENT (which listing, which kind, server-set price) and returns intent_id
--   3. the fn creates a Stripe Checkout Session for that price, intent_id in metadata
--   4. buyer pays on Stripe → `checkout.session.completed` webhook
--   5. edge fn `stripe-webhook` verifies the signature and calls
--      shop_deliver_stripe_order(intent_id, event_id, payment_intent, amount_total)
--   6. delivery resolves the buyer/listing ONLY from the intent (never a price guess),
--      re-validates under the listing lock, and either delivers or returns ok:false so
--      the edge fn REFUNDS the card (web buyers get money back, not app-only credits).
--
-- IDEMPOTENCY IS KEYED ON THE STRIPE EVENT ID, across every branch:
-- shop_stripe_payments(event_id) makes the whole delivery a no-op on a Stripe retry,
-- and the ledger leg is also keyed on (source='stripe', event_id). A duplicate hit
-- returns the recorded OUTCOME so the edge fn can finish a refund that a prior attempt
-- started but could not complete.

do $$
begin
  if not exists (select 1 from pg_proc where proname = 'shop_fee_rate') then
    raise exception 'run shop_credits.sql before shop_stripe.sql';
  end if;
  if not exists (select 1 from pg_proc where proname = 'payout_hold_days') then
    raise exception 'run payouts.sql before shop_stripe.sql';
  end if;
  -- Same exclusivity guard as shop_iap.sql: a Stripe sale concurrent with a credit or
  -- IAP sale of the same exclusive beat must serialize on the listing lock, or two
  -- buyers both get an exclusive. Refuse to install atop an unlocked precheck/delivery.
  if not exists (select 1 from pg_proc where proname = 'shop_order_precheck'  and prosrc ilike '%for update%')
     or not exists (select 1 from pg_proc where proname = 'shop_order_delivered' and prosrc ilike '%for update%') then
    raise exception 'shop_order_precheck/shop_order_delivered must carry FOR UPDATE — run shop_exclusivity_lock.sql LAST.';
  end if;
end $$;


-- ─── 1) Intents + processed-payments ────────────────────────────────────────
-- An intent is one checkout attempt: the durable link from "Buy with card" to the
-- webhook that later delivers it. The ORDER is created only when payment lands (like
-- a credit sale), so this never collides with the one-order-per-(listing,buyer,kind)
-- index.
create table if not exists public.shop_stripe_intents (
  id          uuid primary key default gen_random_uuid(),
  buyer_id    uuid not null references auth.users(id) on delete cascade,
  listing_id  uuid not null references public.shop_listings(id) on delete cascade,
  kind        text not null check (kind in ('sell', 'lease')),
  price_cents int  not null check (price_cents > 0),
  session_id  text,                 -- Stripe Checkout Session id (set by the edge fn)
  status      text not null default 'pending'
                check (status in ('pending', 'delivered', 'failed', 'expired')),
  order_id    uuid references public.shop_orders(id),
  created_at  timestamptz not null default now(),
  -- Stripe Checkout Sessions last ~24h; delivery does NOT gate on this (it resolves a
  -- 'pending' intent whenever payment lands) — it only drives the hygiene sweep.
  expires_at  timestamptz not null default (now() + interval '24 hours')
);

create index if not exists shop_stripe_intents_buyer_idx
  on public.shop_stripe_intents (buyer_id, created_at desc);
create index if not exists shop_stripe_intents_session_idx
  on public.shop_stripe_intents (session_id) where session_id is not null;

alter table public.shop_stripe_intents enable row level security;
-- Read-only for the buyer (the success page polls for delivery). Every write goes
-- through the SECURITY DEFINER RPCs / the service-role edge fn, so no write policy.
drop policy if exists "Buyers read their own stripe intents" on public.shop_stripe_intents;
create policy "Buyers read their own stripe intents"
  on public.shop_stripe_intents for select using (buyer_id = auth.uid());

-- ONE economic effect per Stripe event, across every delivery branch, AND the record a
-- refund reads to reverse the right thing. unique(event_id) makes a Stripe retry a true
-- no-op. Written in the same transaction as the effect, so it rolls back with a failed
-- delivery and a genuine retry can re-process.
create table if not exists public.shop_stripe_payments (
  id                 uuid primary key default gen_random_uuid(),
  event_id           text not null unique,      -- Stripe event id (evt_…)
  buyer_id           uuid references auth.users(id) on delete set null,
  paid_cents         int,
  -- The Stripe PaymentIntent (pi_…) behind this checkout; what a refund acts on, and
  -- what charge.refunded events carry back.
  payment_intent_id  text,
  session_id         text,
  -- 'delivered' a beat (→ order_id); 'failed' = charged but could not deliver and a
  -- card REFUND is owed/started; 'refunded' = that refund completed (or a buyer-side
  -- refund was processed). Null only in the transient window before an outcome is set.
  outcome            text check (outcome in ('delivered', 'failed', 'refunded')),
  order_id           uuid references public.shop_orders(id),
  created_at         timestamptz not null default now()
);
create index if not exists shop_stripe_payments_pi_idx
  on public.shop_stripe_payments (payment_intent_id) where payment_intent_id is not null;
alter table public.shop_stripe_payments enable row level security;  -- service-role only; no policy


-- ─── 2) Begin ───────────────────────────────────────────────────────────────
-- Called (as the buyer, via the edge fn passing the buyer's JWT) before creating a
-- Stripe Checkout Session. Validates the listing/kind, SETS the price server-side
-- (never trusts the client), records/refreshes an intent, returns intent_id + price.
-- Moves no money and reserves nothing — exclusivity is resolved at delivery under the
-- same listing lock a credit/IAP sale takes. No price-tier restriction (Stripe charges
-- any amount).
create or replace function public.shop_begin_stripe_order(p_listing_id uuid, p_kind text)
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
  v_intent public.shop_stripe_intents%rowtype;
begin
  if v_buyer is null then raise exception 'not_signed_in'; end if;
  if p_kind not in ('sell', 'lease') then raise exception 'bad_kind'; end if;  -- free=instant; offer=credits-only

  select * into l from public.shop_listings where id = p_listing_id;
  if l.id is null then raise exception 'listing_not_found'; end if;
  if l.status <> 'active' then raise exception 'listing_not_available'; end if;
  if l.user_id = v_buyer then raise exception 'cannot_buy_own'; end if;

  -- Effective deal types + price, mirroring shop_order_precheck / shop_begin_iap_order.
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
  -- Stripe's own floor (~$0.50 for USD) — a sub-floor price can't be charged.
  if v_price < 50 then raise exception 'price_below_min'; end if;

  -- Already own it? (one delivered order per listing+buyer+kind)
  if exists (
    select 1 from public.shop_orders o
     where o.listing_id = p_listing_id and o.buyer_id = v_buyer
       and coalesce(o.kind, 'legacy') = p_kind and o.status = 'delivered'
  ) then
    raise exception 'already_purchased';
  end if;

  -- Reuse a fresh pending intent for the same target rather than piling them up.
  select * into v_intent from public.shop_stripe_intents
   where buyer_id = v_buyer and listing_id = p_listing_id and kind = p_kind
     and status = 'pending' and expires_at > now()
   order by created_at desc limit 1;

  if v_intent.id is not null then
    update public.shop_stripe_intents
       set price_cents = v_price, session_id = null,
           expires_at  = now() + interval '24 hours'
     where id = v_intent.id
     returning * into v_intent;
  else
    insert into public.shop_stripe_intents (buyer_id, listing_id, kind, price_cents)
      values (v_buyer, p_listing_id, p_kind, v_price)
      returning * into v_intent;
  end if;

  return jsonb_build_object('ok', true, 'intent_id', v_intent.id, 'price_cents', v_price);
end $$;

grant execute on function public.shop_begin_stripe_order(uuid, text) to authenticated;

-- The edge fn records the Stripe session id on the intent after creating it (service
-- role). Separate tiny setter so the edge fn never writes the table directly.
create or replace function public.shop_stripe_attach_session(p_intent_id uuid, p_session_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.shop_stripe_intents
     set session_id = p_session_id
   where id = p_intent_id and status = 'pending';
end $$;


-- ─── 3) Deliver ─────────────────────────────────────────────────────────────
-- Called ONLY by the stripe-webhook (service role) on checkout.session.completed.
-- Delivers a paid beat, or returns ok:false with a reason so the webhook refunds the
-- card. Reuses the precheck + delivery triggers so exclusivity (FOR UPDATE) and
-- auto-decline behave EXACTLY as for a credit/IAP sale. Never raises on an expected
-- business outcome. On a duplicate event it returns the recorded outcome so the webhook
-- can finish a refund a prior attempt started.
create or replace function public.shop_deliver_stripe_order(
  p_intent_id         uuid,
  p_event_id          text,
  p_payment_intent_id text,
  p_paid_cents        int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pay_id   uuid;
  v_intent   public.shop_stripe_intents%rowtype;
  v_buyer    uuid;
  l          public.shop_listings%rowtype;
  v_sell boolean; v_lease boolean;
  v_price    int;
  v_existing public.shop_orders%rowtype;
  v_order    public.shop_orders%rowtype;
  v_fee      bigint;
  v_payout   bigint;
  v_tx       uuid;
  v_outcome  text;
begin
  if p_event_id is null then raise exception 'no_event_id'; end if;

  -- (1) Resolve the intent — the server-authenticated source of truth for WHO is buying
  -- and WHICH listing. Stripe's session metadata carried the id; we never guess by price.
  if p_intent_id is not null then
    select * into v_intent from public.shop_stripe_intents where id = p_intent_id for update;
  end if;
  if v_intent.id is null then
    insert into public.shop_stripe_payments (event_id, paid_cents, payment_intent_id, outcome)
      values (p_event_id, p_paid_cents, p_payment_intent_id, 'failed')
      on conflict (event_id) do nothing;
    -- No intent → refund the stray charge.
    return jsonb_build_object('ok', false, 'reason', 'no_intent', 'refund', true,
                              'payment_intent_id', p_payment_intent_id);
  end if;

  v_buyer := v_intent.buyer_id;

  -- (2) Payment-level idempotency. ONE economic effect per Stripe event. A retry
  -- conflicts here; we return the RECORDED outcome so the webhook can finish a refund
  -- that a prior attempt recorded as owed ('failed') but could not complete.
  insert into public.shop_stripe_payments (event_id, buyer_id, paid_cents, payment_intent_id, session_id)
    values (p_event_id, v_buyer, p_paid_cents, p_payment_intent_id, v_intent.session_id)
    on conflict (event_id) do nothing
    returning id into v_pay_id;
  if v_pay_id is null then
    select outcome into v_outcome from public.shop_stripe_payments where event_id = p_event_id;
    return jsonb_build_object('ok', v_outcome = 'delivered', 'idempotent', true,
                              'reason', 'duplicate_event', 'outcome', v_outcome,
                              'refund', v_outcome = 'failed',
                              'payment_intent_id', p_payment_intent_id);
  end if;

  -- (3) Intent already settled → a second real payment for it → refund it.
  if v_intent.status <> 'pending' then
    update public.shop_stripe_payments set outcome = 'failed' where id = v_pay_id;
    return jsonb_build_object('ok', false, 'reason', 'intent_settled', 'refund', true,
                              'payment_intent_id', p_payment_intent_id);
  end if;

  -- (4) The amount actually charged must equal the price we issued for this intent.
  -- `is distinct from` so a null amount fails CLOSED (counts as a mismatch → refund).
  if p_paid_cents is distinct from v_intent.price_cents then
    update public.shop_stripe_payments set outcome = 'failed' where id = v_pay_id;
    update public.shop_stripe_intents set status = 'failed' where id = v_intent.id;
    return jsonb_build_object('ok', false, 'reason', 'price_mismatch', 'refund', true,
                              'payment_intent_id', p_payment_intent_id);
  end if;

  -- (5) Lock the listing and re-resolve. Only an ACTIVE listing still at the SAME price
  -- (and still offering this kind) delivers. The lock serializes two buyers of the same
  -- exclusive beat: the loser reads 'sold' and is refunded instead of double-sold.
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
    update public.shop_stripe_payments set outcome = 'failed' where id = v_pay_id;
    update public.shop_stripe_intents set status = 'failed' where id = v_intent.id;
    return jsonb_build_object('ok', false, 'reason', 'unavailable', 'refund', true,
                              'payment_intent_id', p_payment_intent_id);
  end if;

  -- (6) One order per (listing, buyer, kind). A pre-existing order means the slot is
  -- taken by another rail (credits/IAP) before this webhook landed — refund the card.
  select * into v_existing from public.shop_orders
    where listing_id = v_intent.listing_id and buyer_id = v_buyer
      and coalesce(kind, 'legacy') = v_intent.kind
    limit 1;
  if v_existing.id is not null then
    update public.shop_stripe_payments set outcome = 'failed' where id = v_pay_id;
    update public.shop_stripe_intents set status = 'failed' where id = v_intent.id;
    return jsonb_build_object('ok', false, 'reason', 'order_slot_taken', 'refund', true,
                              'payment_intent_id', p_payment_intent_id);
  end if;

  v_fee    := round(v_intent.price_cents * public.shop_fee_rate());
  v_payout := v_intent.price_cents - v_fee;

  -- (7) Deliver. Insert the order (precheck re-validates + re-prices under the lock we
  -- hold; fee_cents set at INSERT to satisfy shop_orders_guard, exactly as IAP does),
  -- post the sale keyed on the Stripe event, flip to delivered (the trigger marks an
  -- exclusive listing sold and auto-declines pending requests — identical to credits/IAP).
  insert into public.shop_orders (listing_id, buyer_id, seller_id, kind, price_cents, fee_cents, status)
    values (v_intent.listing_id, v_buyer, l.user_id, v_intent.kind, v_intent.price_cents, v_fee, 'requested')
    returning * into v_order;

  v_tx := public.ledger_post('purchase',
    jsonb_build_array(
      jsonb_build_object('user', l.user_id, 'kind', 'earnings', 'amount_cents', v_payout,
                         'available_at', now() + (public.payout_hold_days() || ' days')::interval),
      jsonb_build_object('user', null,      'kind', 'platform', 'amount_cents', v_fee),
      jsonb_build_object('user', null,      'kind', 'platform', 'amount_cents', -v_intent.price_cents)),
    'stripe', p_event_id, 'Beat purchase (web / card)');

  update public.shop_orders
     set status = 'delivered', delivered_at = now(), fee_cents = v_fee
   where id = v_order.id;

  update public.shop_stripe_intents
     set status = 'delivered', order_id = v_order.id
   where id = v_intent.id;

  update public.shop_stripe_payments
     set outcome = 'delivered', order_id = v_order.id
   where id = v_pay_id;

  return jsonb_build_object('ok', true, 'delivered', true, 'order_id', v_order.id,
                            'seller_cents', v_payout, 'fee_cents', v_fee, 'transaction_id', v_tx);
end $$;

-- Invariant 5 (ledger.sql): nothing client-side may deliver. Service role only.
revoke all on function public.shop_deliver_stripe_order(uuid, text, text, int) from public;
revoke all on function public.shop_deliver_stripe_order(uuid, text, text, int) from authenticated;


-- ─── 4) Record a completed card refund ──────────────────────────────────────
-- After the webhook refunds a 'failed' (charged-but-undeliverable) payment via Stripe,
-- it calls this to flip the payment to 'refunded' so a retry won't refund twice.
create or replace function public.shop_stripe_mark_refunded(p_event_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.shop_stripe_payments
     set outcome = 'refunded'
   where event_id = p_event_id and outcome = 'failed';
end $$;

revoke all on function public.shop_stripe_mark_refunded(text) from public;
revoke all on function public.shop_stripe_mark_refunded(text) from authenticated;


-- ─── 5) Buyer-initiated refund (charge.refunded webhook) ────────────────────
-- A refund issued from the Stripe dashboard for a DELIVERED order: revoke file access
-- by flipping the order to 'refunded'. Matched by PaymentIntent id. Per the shop refund
-- policy (shop_credits.sql), the SELLER is not clawed back (the ledger refuses a
-- negative user balance once withdrawn); only the order status drops. Idempotent.
create or replace function public.shop_stripe_refund_delivered(p_payment_intent_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_pay public.shop_stripe_payments%rowtype;
begin
  if p_payment_intent_id is null then return jsonb_build_object('ok', false, 'reason', 'no_pi'); end if;
  select * into v_pay from public.shop_stripe_payments
    where payment_intent_id = p_payment_intent_id order by created_at desc limit 1;
  if v_pay.id is null then
    return jsonb_build_object('ok', false, 'reason', 'payment_not_found');
  end if;
  if v_pay.outcome = 'delivered' and v_pay.order_id is not null then
    update public.shop_orders set status = 'refunded', refunded_at = now()
     where id = v_pay.order_id and status = 'delivered';
    update public.shop_stripe_payments set outcome = 'refunded' where id = v_pay.id;
    return jsonb_build_object('ok', true, 'revoked', true, 'order_id', v_pay.order_id);
  end if;
  return jsonb_build_object('ok', true, 'noop', true);  -- failed/already-refunded
end $$;

revoke all on function public.shop_stripe_refund_delivered(text) from public;
revoke all on function public.shop_stripe_refund_delivered(text) from authenticated;


-- ─── 6) Poll ────────────────────────────────────────────────────────────────
-- The success page calls this after Stripe returns to show "unlocking…" until the
-- webhook has delivered (or refunded) the purchase.
create or replace function public.shop_poll_stripe_order(p_intent_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_intent public.shop_stripe_intents%rowtype;
begin
  select * into v_intent from public.shop_stripe_intents where id = p_intent_id;
  -- `is distinct from` so ownership fails CLOSED for a null auth.uid() (no/invalid JWT).
  if v_intent.id is null or v_intent.buyer_id is distinct from auth.uid() then
    raise exception 'not_found';
  end if;
  return jsonb_build_object(
    'status', v_intent.status,
    'order_id', v_intent.order_id,
    'delivered', v_intent.status = 'delivered',
    'refunded', v_intent.status = 'failed'   -- a failed delivery was refunded to card
  );
end $$;

grant execute on function public.shop_poll_stripe_order(uuid) to authenticated;


-- ─── 7) Intent sweep (optional cron) ────────────────────────────────────────
-- Hygiene only (delivery resolves intents by id, never by scanning pending rows).
create or replace function public.shop_sweep_stripe_intents()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_n int;
begin
  update public.shop_stripe_intents set status = 'expired'
    where status = 'pending' and expires_at < now();
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.shop_sweep_stripe_intents() from public;
revoke all on function public.shop_sweep_stripe_intents() from authenticated;


-- ─── Revoke anon, BY NAME (the load-bearing one) ────────────────────────────
-- Supabase's bootstrap grants EXECUTE to anon on every new public function, and
-- `revoke … from public`/`authenticated` does NOT remove it. The anon key is public,
-- so without these a deliver/refund RPC would be callable with no JWT → anyone could
-- mint withdrawable earnings. Revoke anon by name. Pre-flight (all false):
--   select p.proname, has_function_privilege('anon', p.oid, 'execute')
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname='public' and p.proname like 'shop_%stripe%';
revoke all on function public.shop_begin_stripe_order(uuid, text)                     from public, anon;
revoke all on function public.shop_stripe_attach_session(uuid, text)                  from public, anon, authenticated;
revoke all on function public.shop_deliver_stripe_order(uuid, text, text, int)        from anon;
revoke all on function public.shop_stripe_mark_refunded(text)                         from anon;
revoke all on function public.shop_stripe_refund_delivered(text)                      from anon;
revoke all on function public.shop_poll_stripe_order(uuid)                            from public, anon;
revoke all on function public.shop_sweep_stripe_intents()                             from anon;


-- ─── Checking it ────────────────────────────────────────────────────────────
--   Exactly one ledger tx per Stripe event (should return NO rows):
--     select source, external_id, count(*) from public.ledger_transactions
--      where source = 'stripe' group by 1,2 having count(*) > 1;
--   Every committed payment recorded an outcome (should return NO rows):
--     select count(*) from public.shop_stripe_payments where outcome is null;
--   No listing Stripe-sold (sell) twice (should return NO rows):
--     select i.listing_id, count(*) from public.shop_stripe_intents i
--      where i.status = 'delivered' and i.kind = 'sell' group by 1 having count(*) > 1;
--   Global solvency unchanged:  select * from public.ledger_verify();  -- expect 0 rows
--
-- Rollback:
--   drop function if exists public.shop_sweep_stripe_intents(),
--     public.shop_poll_stripe_order(uuid), public.shop_stripe_refund_delivered(text),
--     public.shop_stripe_mark_refunded(text),
--     public.shop_deliver_stripe_order(uuid,text,text,int),
--     public.shop_stripe_attach_session(uuid,text), public.shop_begin_stripe_order(uuid,text);
--   drop table if exists public.shop_stripe_payments, public.shop_stripe_intents;
