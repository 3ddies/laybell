-- Multi-item (CART) card checkout for the shop via STRIPE (web only).
-- Run AFTER shop_stripe.sql (reuses its intents / payments / tax-fund, the exclusivity
-- lock, and the ledger). Idempotent; re-runnable.
-- ⚠️ MONEY CODE — DO NOT RUN until reviewed. Built on the web-shop-checkout branch.
--
-- WHAT A CART IS
-- One Stripe Checkout Session with N line items (N beats). Economically it is N independent
-- single-item sales that must settle ATOMICALLY: the webhook delivers ALL N or NONE. If any
-- item is unavailable when payment lands (an exclusive someone else just bought, a price
-- change), the whole charge is refunded and nothing is delivered — the buyer retries.
-- (All-or-nothing keeps the accounting simple + review-safe; partial fulfillment with
-- per-item refunds is a deliberate v2.)
--
-- MODEL
-- A shop_stripe_carts row groups N shop_stripe_intents rows (each an item, carrying
-- cart_id). Delivery validates EVERY item under its listing lock first (phase 1), then
-- delivers every item (phase 2), all in ONE transaction holding all the locks, so the set
-- cannot change between the check and the delivery. Idempotency is identical to single-item:
-- one shop_stripe_payments row per Stripe event id guards the whole cart delivery, and each
-- item posts its own ledger legs keyed on event_id||'#'||index.

do $$
begin
  if not exists (select 1 from pg_proc where proname = 'shop_deliver_stripe_order') then
    raise exception 'run shop_stripe.sql before shop_stripe_cart.sql';
  end if;
end $$;


-- ─── 1) Carts + cart grouping ───────────────────────────────────────────────
create table if not exists public.shop_stripe_carts (
  id         uuid primary key default gen_random_uuid(),
  buyer_id   uuid not null references auth.users(id) on delete cascade,
  session_id text,
  status     text not null default 'pending'
               check (status in ('pending', 'delivered', 'failed', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);
create index if not exists shop_stripe_carts_buyer_idx
  on public.shop_stripe_carts (buyer_id, created_at desc);
create index if not exists shop_stripe_carts_session_idx
  on public.shop_stripe_carts (session_id) where session_id is not null;
alter table public.shop_stripe_carts enable row level security;
drop policy if exists "Buyers read their own carts" on public.shop_stripe_carts;
create policy "Buyers read their own carts"
  on public.shop_stripe_carts for select using (buyer_id = auth.uid());

-- Group N intents into a cart (null cart_id = a single-item buy-now intent, unchanged).
alter table public.shop_stripe_intents
  add column if not exists cart_id uuid references public.shop_stripe_carts(id) on delete cascade;
create index if not exists shop_stripe_intents_cart_idx
  on public.shop_stripe_intents (cart_id) where cart_id is not null;

-- The payment row can belong to a cart (so a refund can revoke every order in it).
alter table public.shop_stripe_payments
  add column if not exists cart_id uuid references public.shop_stripe_carts(id) on delete set null;

-- A tax-fund row can now belong to a single order OR a whole cart (exactly one). Relax the
-- single-order assumption from shop_stripe.sql.
alter table public.shop_tax_collected alter column order_id drop not null;
alter table public.shop_tax_collected
  add column if not exists cart_id uuid references public.shop_stripe_carts(id) on delete set null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shop_tax_collected_one_parent') then
    alter table public.shop_tax_collected
      add constraint shop_tax_collected_one_parent check (num_nonnulls(order_id, cart_id) = 1);
  end if;
end $$;


-- ─── 2) Begin a cart ────────────────────────────────────────────────────────
-- Called (as the buyer, via the edge fn) before creating the Stripe Session. Validates
-- every item, SETS each price server-side, records a cart + N intents, and returns the
-- items (with price/title/cover) for the session line items. Moves no money; reserves
-- nothing (exclusivity is resolved at delivery under the listing lock). Raises on the first
-- bad item (the whole begin rolls back — no partial cart); the cart page pre-checks items so
-- this is the rare race case.
create or replace function public.shop_begin_stripe_cart(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_buyer   uuid := auth.uid();
  v_cart    uuid;
  v_n       int;
  v_item    jsonb;
  v_listing uuid;
  v_kind    text;
  l         public.shop_listings%rowtype;
  v_sell boolean; v_lease boolean;
  v_price   int;
  v_total   bigint := 0;
  v_out     jsonb := '[]'::jsonb;
  v_seen    jsonb := '[]'::jsonb;  -- dedupe (listing, kind)
begin
  if v_buyer is null then raise exception 'not_signed_in'; end if;
  if jsonb_typeof(p_items) <> 'array' then raise exception 'bad_request'; end if;
  v_n := jsonb_array_length(p_items);
  if v_n < 1  then raise exception 'cart_empty'; end if;
  if v_n > 20 then raise exception 'cart_too_large'; end if;

  -- Don't pile up stale pending carts for this buyer.
  update public.shop_stripe_carts set status = 'expired'
    where buyer_id = v_buyer and status = 'pending';

  insert into public.shop_stripe_carts (buyer_id) values (v_buyer) returning id into v_cart;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_listing := nullif(v_item->>'listing_id', '')::uuid;
    v_kind    := v_item->>'kind';
    if v_listing is null or v_kind not in ('sell', 'lease') then raise exception 'bad_item'; end if;

    if v_seen @> jsonb_build_array(jsonb_build_object('l', v_listing, 'k', v_kind)) then
      raise exception 'duplicate_item';
    end if;
    v_seen := v_seen || jsonb_build_array(jsonb_build_object('l', v_listing, 'k', v_kind));

    select * into l from public.shop_listings where id = v_listing;
    if l.id is null then raise exception 'listing_not_found'; end if;
    if l.status <> 'active' then raise exception 'listing_not_available'; end if;
    if l.user_id = v_buyer then raise exception 'cannot_buy_own'; end if;

    v_sell  := l.sell_enabled  or (not (l.sell_enabled or l.lease_enabled or l.free_enabled) and l.license = 'exclusive');
    v_lease := l.lease_enabled or (not (l.sell_enabled or l.lease_enabled or l.free_enabled) and l.license = 'nonexclusive');
    if v_kind = 'sell' then
      if not v_sell then raise exception 'kind_not_available'; end if;
      v_price := case when l.sell_enabled then l.sell_price_cents else l.price_cents end;
    else
      if not v_lease then raise exception 'kind_not_available'; end if;
      v_price := case when l.lease_enabled then l.lease_price_cents else l.price_cents end;
    end if;
    if v_price is null or v_price <= 0 then raise exception 'price_unset'; end if;

    if exists (
      select 1 from public.shop_orders o
       where o.listing_id = v_listing and o.buyer_id = v_buyer
         and coalesce(o.kind, 'legacy') = v_kind and o.status = 'delivered'
    ) then
      raise exception 'already_purchased';
    end if;

    insert into public.shop_stripe_intents (buyer_id, listing_id, kind, price_cents, cart_id)
      values (v_buyer, v_listing, v_kind, v_price, v_cart);

    v_total := v_total + v_price;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'listing_id', v_listing, 'kind', v_kind, 'price_cents', v_price,
      'title', l.title, 'cover_url', l.cover_url));
  end loop;

  -- Stripe's per-transaction floor (~$0.50 USD) applies to the cart TOTAL.
  if v_total < 50 then raise exception 'cart_below_min'; end if;

  return jsonb_build_object('ok', true, 'cart_id', v_cart, 'total_cents', v_total, 'items', v_out);
end $$;

grant execute on function public.shop_begin_stripe_cart(jsonb) to authenticated;

-- The edge fn records the Stripe session id on the cart after creating it (service role).
create or replace function public.shop_stripe_attach_cart_session(p_cart_id uuid, p_session_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.shop_stripe_carts set session_id = p_session_id
   where id = p_cart_id and status = 'pending';
end $$;


-- ─── 3) Deliver a cart (all-or-nothing) ─────────────────────────────────────
-- Called ONLY by the stripe-webhook (service role) on checkout.session.completed for a cart
-- session. Delivers every item or none; returns ok:false + refund:true so the webhook
-- refunds the WHOLE charge if anything is off. Idempotent on the Stripe event id.
create or replace function public.shop_deliver_stripe_cart(
  p_cart_id           uuid,
  p_event_id          text,
  p_payment_intent_id text,
  p_total_cents       int,            -- amount_total Stripe charged (sum of prices + tax)
  p_subtotal_cents    int,            -- amount_subtotal = sum of the item prices we issued
  p_tax_cents         int  default 0,
  p_tax_country       text default null,
  p_tax_state         text default null,
  p_currency          text default 'usd'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pay_id  uuid;
  v_outcome text;
  v_cart    public.shop_stripe_carts%rowtype;
  v_buyer   uuid;
  v_sum     bigint := 0;
  rec       record;
  l         public.shop_listings%rowtype;
  v_sell boolean; v_lease boolean;
  v_price   int;
  v_fee     bigint;
  v_payout  bigint;
  v_order   public.shop_orders%rowtype;
  v_i       int := 0;
  v_orders  uuid[] := '{}';
begin
  if p_event_id is null then raise exception 'no_event_id'; end if;

  -- (1) Resolve the cart — the server-authenticated source of WHO is buying and WHICH items.
  if p_cart_id is not null then
    select * into v_cart from public.shop_stripe_carts where id = p_cart_id for update;
  end if;
  if v_cart.id is null then
    insert into public.shop_stripe_payments (event_id, paid_cents, payment_intent_id, outcome)
      values (p_event_id, p_total_cents, p_payment_intent_id, 'failed')
      on conflict (event_id) do nothing;
    return jsonb_build_object('ok', false, 'reason', 'no_cart', 'refund', true,
                              'payment_intent_id', p_payment_intent_id);
  end if;
  v_buyer := v_cart.buyer_id;

  -- (2) Payment-level idempotency. ONE economic effect per Stripe event, guarding the WHOLE
  -- cart. A retry conflicts here and returns the recorded outcome so the webhook can finish a
  -- refund a prior attempt recorded as owed.
  insert into public.shop_stripe_payments (event_id, buyer_id, paid_cents, payment_intent_id, cart_id)
    values (p_event_id, v_buyer, p_total_cents, p_payment_intent_id, p_cart_id)
    on conflict (event_id) do nothing
    returning id into v_pay_id;
  if v_pay_id is null then
    select outcome into v_outcome from public.shop_stripe_payments where event_id = p_event_id;
    return jsonb_build_object('ok', v_outcome = 'delivered', 'idempotent', true, 'outcome', v_outcome,
                              'refund', v_outcome = 'failed', 'payment_intent_id', p_payment_intent_id);
  end if;

  if v_cart.status <> 'pending' then
    update public.shop_stripe_payments set outcome = 'failed' where id = v_pay_id;
    return jsonb_build_object('ok', false, 'reason', 'cart_settled', 'refund', true,
                              'payment_intent_id', p_payment_intent_id);
  end if;

  -- (3) PHASE 1 — validate EVERY item under its listing lock (ordered by listing_id to avoid
  -- deadlocks between carts that share a beat). Nothing is delivered yet; any failure refunds
  -- the whole charge.
  for rec in
    select i.* from public.shop_stripe_intents i
     where i.cart_id = p_cart_id order by i.listing_id, i.kind
  loop
    select * into l from public.shop_listings where id = rec.listing_id for update;
    if l.id is not null then
      v_sell  := l.sell_enabled  or (not (l.sell_enabled or l.lease_enabled or l.free_enabled) and l.license = 'exclusive');
      v_lease := l.lease_enabled or (not (l.sell_enabled or l.lease_enabled or l.free_enabled) and l.license = 'nonexclusive');
      if rec.kind = 'sell' then
        v_price := case when l.sell_enabled then l.sell_price_cents else l.price_cents end;
      else
        v_price := case when l.lease_enabled then l.lease_price_cents else l.price_cents end;
      end if;
    end if;

    if l.id is null or l.status <> 'active'
       or v_price is distinct from rec.price_cents
       or (rec.kind = 'sell'  and not v_sell)
       or (rec.kind = 'lease' and not v_lease)
       or exists (
         select 1 from public.shop_orders o
          where o.listing_id = rec.listing_id and o.buyer_id = v_buyer
            and coalesce(o.kind, 'legacy') = rec.kind
       )
    then
      update public.shop_stripe_payments set outcome = 'failed' where id = v_pay_id;
      update public.shop_stripe_carts set status = 'failed' where id = p_cart_id;
      update public.shop_stripe_intents set status = 'failed' where cart_id = p_cart_id and status = 'pending';
      return jsonb_build_object('ok', false, 'reason', 'item_unavailable', 'refund', true,
                                'listing_id', rec.listing_id, 'payment_intent_id', p_payment_intent_id);
    end if;
    v_sum := v_sum + rec.price_cents;
  end loop;

  -- (4) Verify the money: subtotal = sum of item prices, and total = subtotal + tax.
  -- `is distinct from` so a null amount fails CLOSED (refund).
  if p_subtotal_cents is distinct from v_sum
     or coalesce(p_tax_cents, 0) < 0
     or p_total_cents is distinct from (v_sum + coalesce(p_tax_cents, 0)) then
    update public.shop_stripe_payments set outcome = 'failed' where id = v_pay_id;
    update public.shop_stripe_carts set status = 'failed' where id = p_cart_id;
    update public.shop_stripe_intents set status = 'failed' where cart_id = p_cart_id and status = 'pending';
    return jsonb_build_object('ok', false, 'reason', 'amount_mismatch', 'refund', true,
                              'payment_intent_id', p_payment_intent_id);
  end if;

  -- (5) PHASE 2 — deliver EVERY item. We still hold all the listing locks taken in phase 1
  -- (same transaction), so availability cannot have changed. Each item posts its own balanced
  -- ledger legs keyed on event_id||'#'||index (unique per item). The delivered-trigger marks
  -- an exclusive listing sold + auto-declines its pending requests, exactly as a single sale.
  for rec in
    select i.* from public.shop_stripe_intents i
     where i.cart_id = p_cart_id order by i.listing_id, i.kind
  loop
    select * into l from public.shop_listings where id = rec.listing_id;  -- already locked in phase 1
    v_fee    := round(rec.price_cents * public.shop_fee_rate());
    v_payout := rec.price_cents - v_fee;

    insert into public.shop_orders (listing_id, buyer_id, seller_id, kind, price_cents, fee_cents, status)
      values (rec.listing_id, v_buyer, l.user_id, rec.kind, rec.price_cents, v_fee, 'requested')
      returning * into v_order;

    perform public.ledger_post('purchase',
      jsonb_build_array(
        jsonb_build_object('user', l.user_id, 'kind', 'earnings', 'amount_cents', v_payout,
                           'available_at', now() + (public.payout_hold_days() || ' days')::interval),
        jsonb_build_object('user', null, 'kind', 'platform', 'amount_cents', v_fee),
        jsonb_build_object('user', null, 'kind', 'platform', 'amount_cents', -rec.price_cents)),
      'stripe', p_event_id || '#' || v_i, 'Beat purchase (web / cart)');

    update public.shop_orders
       set status = 'delivered', delivered_at = now(), fee_cents = v_fee
     where id = v_order.id;
    update public.shop_stripe_intents set status = 'delivered', order_id = v_order.id where id = rec.id;

    v_orders := v_orders || v_order.id;
    v_i := v_i + 1;
  end loop;

  -- (6) Bank the cart's tax (one row for the whole cart; tax is per-jurisdiction, and every
  -- item in a cart shares the one buyer → one jurisdiction).
  if coalesce(p_tax_cents, 0) > 0 then
    insert into public.shop_tax_collected
      (cart_id, event_id, buyer_id, subtotal_cents, tax_cents, total_cents, country, state, currency)
    values (p_cart_id, p_event_id, v_buyer, v_sum, p_tax_cents, p_total_cents,
            upper(nullif(p_tax_country, '')), upper(nullif(p_tax_state, '')),
            lower(coalesce(nullif(p_currency, ''), 'usd')));
  end if;

  update public.shop_stripe_carts set status = 'delivered' where id = p_cart_id;
  update public.shop_stripe_payments set outcome = 'delivered' where id = v_pay_id;

  return jsonb_build_object('ok', true, 'delivered', true, 'cart_id', p_cart_id,
                            'order_ids', v_orders, 'items', v_i, 'tax_cents', coalesce(p_tax_cents, 0));
end $$;

-- Service role only — nothing client-side may deliver.
revoke all on function public.shop_deliver_stripe_cart(uuid, text, text, int, int, int, text, text, text) from public, authenticated;


-- ─── 4) Cart-aware refund (charge.refunded) ─────────────────────────────────
-- Replaces the single-order version so a refund on a CART charge revokes EVERY delivered
-- order in the cart and reverses the cart's tax. Single-order behavior is unchanged. Matched
-- by PaymentIntent id; idempotent; sellers are not clawed back (shop refund policy).
create or replace function public.shop_stripe_refund_delivered(p_payment_intent_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_pay public.shop_stripe_payments%rowtype; v_n int := 0;
begin
  if p_payment_intent_id is null then return jsonb_build_object('ok', false, 'reason', 'no_pi'); end if;
  select * into v_pay from public.shop_stripe_payments
    where payment_intent_id = p_payment_intent_id order by created_at desc limit 1;
  if v_pay.id is null then return jsonb_build_object('ok', false, 'reason', 'payment_not_found'); end if;
  if v_pay.outcome <> 'delivered' then return jsonb_build_object('ok', true, 'noop', true); end if;

  if v_pay.cart_id is not null then
    -- Cart: revoke every delivered order in it + reverse its tax.
    update public.shop_orders set status = 'refunded', refunded_at = now()
     where id in (select order_id from public.shop_stripe_intents
                   where cart_id = v_pay.cart_id and order_id is not null)
       and status = 'delivered';
    get diagnostics v_n = row_count;
    update public.shop_tax_collected set reversed_at = now()
     where cart_id = v_pay.cart_id and reversed_at is null;
    update public.shop_stripe_payments set outcome = 'refunded' where id = v_pay.id;
    return jsonb_build_object('ok', true, 'revoked', true, 'cart', true, 'orders', v_n);
  end if;

  -- Single order (unchanged).
  if v_pay.order_id is not null then
    update public.shop_orders set status = 'refunded', refunded_at = now()
     where id = v_pay.order_id and status = 'delivered';
    update public.shop_stripe_payments set outcome = 'refunded' where id = v_pay.id;
    update public.shop_tax_collected set reversed_at = now()
     where order_id = v_pay.order_id and reversed_at is null;
    return jsonb_build_object('ok', true, 'revoked', true, 'order_id', v_pay.order_id);
  end if;
  return jsonb_build_object('ok', true, 'noop', true);
end $$;


-- ─── 5) Poll + sweep ────────────────────────────────────────────────────────
create or replace function public.shop_poll_stripe_cart(p_cart_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_cart public.shop_stripe_carts%rowtype;
begin
  select * into v_cart from public.shop_stripe_carts where id = p_cart_id;
  -- `is distinct from` so ownership fails CLOSED for a null auth.uid().
  if v_cart.id is null or v_cart.buyer_id is distinct from auth.uid() then
    raise exception 'not_found';
  end if;
  return jsonb_build_object('status', v_cart.status, 'cart_id', v_cart.id,
                            'delivered', v_cart.status = 'delivered',
                            'refunded', v_cart.status = 'failed');  -- a failed cart was refunded
end $$;

grant execute on function public.shop_poll_stripe_cart(uuid) to authenticated;

create or replace function public.shop_sweep_stripe_carts()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_n int;
begin
  update public.shop_stripe_carts set status = 'expired'
    where status = 'pending' and expires_at < now();
  get diagnostics v_n = row_count;
  update public.shop_stripe_intents set status = 'expired'
    where status = 'pending'
      and cart_id in (select id from public.shop_stripe_carts where status = 'expired');
  return v_n;
end $$;


-- ─── Revoke anon, BY NAME (the load-bearing one; see shop_stripe.sql) ────────
--   select p.proname, has_function_privilege('anon', p.oid, 'execute')
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname='public' and p.proname like 'shop_%stripe%cart%';  -- all false
revoke all on function public.shop_begin_stripe_cart(jsonb)                                          from public, anon;
revoke all on function public.shop_stripe_attach_cart_session(uuid, text)                            from public, anon, authenticated;
revoke all on function public.shop_deliver_stripe_cart(uuid, text, text, int, int, int, text, text, text) from anon;
revoke all on function public.shop_stripe_refund_delivered(text)                                     from public, anon, authenticated;
revoke all on function public.shop_poll_stripe_cart(uuid)                                             from public, anon;
revoke all on function public.shop_sweep_stripe_carts()                                              from public, anon, authenticated;


-- ─── Checking it ────────────────────────────────────────────────────────────
--   Exactly one ledger tx per (event, item) (NO rows):
--     select source, external_id, count(*) from public.ledger_transactions
--      where source='stripe' and external_id like '%#%' group by 1,2 having count(*) > 1;
--   No exclusive listing cart-sold twice (NO rows):
--     select i.listing_id, count(*) from public.shop_stripe_intents i
--      where i.status='delivered' and i.kind='sell' and i.cart_id is not null
--      group by 1 having count(*) > 1;
--   Every cart that charged recorded an outcome (NO rows):
--     select count(*) from public.shop_stripe_payments where cart_id is not null and outcome is null;
--   Global solvency unchanged:  select * from public.ledger_verify();  -- expect 0 rows
--
-- Rollback:
--   drop function if exists public.shop_sweep_stripe_carts(), public.shop_poll_stripe_cart(uuid),
--     public.shop_deliver_stripe_cart(uuid,text,text,int,int,int,text,text,text),
--     public.shop_stripe_attach_cart_session(uuid,text), public.shop_begin_stripe_cart(jsonb);
--   -- (shop_stripe_refund_delivered reverts to the shop_stripe.sql version on re-run of that file)
--   alter table public.shop_tax_collected drop constraint if exists shop_tax_collected_one_parent;
--   -- columns shop_stripe_intents.cart_id / shop_stripe_payments.cart_id / shop_tax_collected.cart_id
--   -- are additive and safe to leave; drop the shop_stripe_carts table only after clearing them.
