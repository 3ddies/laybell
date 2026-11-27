-- GUEST (no-account) CART card checkout for the shop via STRIPE (web only).
-- Run AFTER shop_stripe.sql + shop_stripe_cart.sql + shop_stripe_guest.sql. Idempotent; re-runnable.
-- ⚠️ MONEY CODE — DO NOT RUN until reviewed. Built on the web-shop-checkout branch.
--
-- WHAT THIS IS
-- The guest (buyer_id null) analogue of shop_stripe_cart.sql. A browser with NO Laybell account
-- buys N beats in ONE Stripe Checkout Session; the webhook delivers ALL N or NONE as guest
-- orders (buyer null + a per-item download token), emails the links, and the success page shows
-- every download. It REUSES the cart grouping (shop_stripe_carts), the exclusivity lock, the
-- ledger and the tax fund exactly as the logged-in cart; the only differences are buyer_id is
-- null, each item carries a CSPRNG download token, and there is no "already owned" check
-- (guests have no history). All-or-nothing, same as the logged-in cart.
--
-- Pairs with: shop-guest-cart-checkout (edge fn) + stripe-webhook (guest_cart_id routing).

do $$
begin
  if not exists (select 1 from pg_proc where proname = 'shop_deliver_stripe_cart') then
    raise exception 'run shop_stripe_cart.sql before shop_stripe_guest_cart.sql';
  end if;
  if not exists (select 1 from pg_proc where proname = 'shop_deliver_stripe_guest_order') then
    raise exception 'run shop_stripe_guest.sql before shop_stripe_guest_cart.sql';
  end if;
end $$;


-- ─── 1) Allow a GUEST cart (no buyer) ───────────────────────────────────────
-- A guest cart has no buyer_id. (The logged-in cart is unaffected: its buyer_id is set, and the
-- "Buyers read their own carts" RLS policy simply never matches a null-buyer cart — guests read
-- their result through the definer poll below, keyed on the unguessable cart id.)
alter table public.shop_stripe_carts alter column buyer_id drop not null;
alter table public.shop_stripe_carts add column if not exists guest_email text;


-- ─── 2) Begin a guest cart (service role, via the public edge fn) ───────────
-- Mirrors shop_begin_stripe_cart, minus auth.uid()/own/already-owned, plus a token per item.
-- Validates every item, SETS each price server-side, records a guest cart + N guest intents
-- (buyer null, each with a token), and returns the items for the Stripe line items. Moves no
-- money; reserves nothing (exclusivity is resolved at delivery under the listing lock).
create or replace function public.shop_begin_stripe_guest_cart(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
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
  v_seen    uuid[] := '{}';         -- one cart entry per listing (see dedupe below)
  v_token   text;
begin
  if jsonb_typeof(p_items) <> 'array' then raise exception 'bad_request'; end if;
  v_n := jsonb_array_length(p_items);
  if v_n < 1  then raise exception 'cart_empty'; end if;
  if v_n > 20 then raise exception 'cart_too_large'; end if;

  insert into public.shop_stripe_carts (buyer_id) values (null) returning id into v_cart;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_listing := nullif(v_item->>'listing_id', '')::uuid;
    v_kind    := v_item->>'kind';
    if v_listing is null or v_kind not in ('sell', 'lease') then raise exception 'bad_item'; end if;

    -- One entry per LISTING (not per listing+kind): carting a beat's exclusive sell alongside
    -- its own lease would deliver the sell (marking the listing sold) and then break the second
    -- item in the same transaction. One line per beat avoids that.
    if v_listing = any(v_seen) then raise exception 'duplicate_item'; end if;
    v_seen := v_seen || v_listing;

    select * into l from public.shop_listings where id = v_listing;
    if l.id is null then raise exception 'listing_not_found'; end if;
    if l.status <> 'active' then raise exception 'listing_not_available'; end if;

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

    -- 64 hex chars from TWO core gen_random_uuid() (always in search_path; NOT pgcrypto —
    -- see shop_stripe_guest.sql). uuid v4 is CSPRNG-backed → unguessable token.
    v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    insert into public.shop_stripe_intents (buyer_id, listing_id, kind, price_cents, cart_id, download_token)
      values (null, v_listing, v_kind, v_price, v_cart, v_token);

    v_total := v_total + v_price;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'listing_id', v_listing, 'kind', v_kind, 'price_cents', v_price,
      'title', l.title, 'cover_url', l.cover_url));
  end loop;

  -- Stripe's per-transaction floor (~$0.50 USD) applies to the cart TOTAL.
  if v_total < 50 then raise exception 'cart_below_min'; end if;

  return jsonb_build_object('ok', true, 'cart_id', v_cart, 'total_cents', v_total, 'items', v_out);
end $$;

-- Service role only (the public shop-guest-cart-checkout edge fn calls it); never a client role.
revoke all on function public.shop_begin_stripe_guest_cart(jsonb) from public, anon, authenticated;


-- ─── 3) Deliver a guest cart (webhook / service role, all-or-nothing) ───────
-- Mirrors shop_deliver_stripe_cart but delivers GUEST orders (buyer null + token + the email
-- Stripe collected). Two-phase under all the listing locks; each item posts its own balanced
-- ledger legs keyed on event_id||'#'||index; idempotent on the Stripe event id. Returns the
-- tokens so the webhook can email every link.
create or replace function public.shop_deliver_stripe_guest_cart(
  p_cart_id           uuid,
  p_event_id          text,
  p_payment_intent_id text,
  p_total_cents       int,
  p_subtotal_cents    int,
  p_tax_cents         int  default 0,
  p_tax_country       text default null,
  p_tax_state         text default null,
  p_currency          text default 'usd',
  p_email             text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pay_id    uuid;
  v_outcome   text;
  v_cart      public.shop_stripe_carts%rowtype;
  v_sum       bigint := 0;
  rec         record;
  l           public.shop_listings%rowtype;
  v_sell boolean; v_lease boolean;
  v_price     int;
  v_fee       bigint;
  v_payout    bigint;
  v_order     public.shop_orders%rowtype;
  v_i         int := 0;
  v_downloads jsonb := '[]'::jsonb;
  v_email     text := nullif(trim(p_email), '');
begin
  if p_event_id is null then raise exception 'no_event_id'; end if;

  -- (1) Resolve the GUEST cart (buyer_id must be null — a logged-in cart never routes here).
  if p_cart_id is not null then
    select * into v_cart from public.shop_stripe_carts where id = p_cart_id and buyer_id is null for update;
  end if;
  if v_cart.id is null then
    insert into public.shop_stripe_payments (event_id, paid_cents, payment_intent_id, outcome)
      values (p_event_id, p_total_cents, p_payment_intent_id, 'failed')
      on conflict (event_id) do nothing;
    return jsonb_build_object('ok', false, 'reason', 'no_cart', 'refund', true,
                              'payment_intent_id', p_payment_intent_id);
  end if;

  -- (2) Payment-level idempotency — ONE economic effect per Stripe event, guarding the WHOLE cart.
  insert into public.shop_stripe_payments (event_id, buyer_id, paid_cents, payment_intent_id, cart_id)
    values (p_event_id, null, p_total_cents, p_payment_intent_id, p_cart_id)
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
  -- deadlocks between carts that share a beat). Nothing delivered yet; any failure refunds all.
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
       or (rec.kind = 'lease' and not v_lease) then
      update public.shop_stripe_payments set outcome = 'failed' where id = v_pay_id;
      update public.shop_stripe_carts set status = 'failed' where id = p_cart_id;
      update public.shop_stripe_intents set status = 'failed' where cart_id = p_cart_id and status = 'pending';
      return jsonb_build_object('ok', false, 'reason', 'item_unavailable', 'refund', true,
                                'listing_id', rec.listing_id, 'payment_intent_id', p_payment_intent_id);
    end if;
    v_sum := v_sum + rec.price_cents;
  end loop;

  -- (4) Verify the money: subtotal = sum of item prices, total = subtotal + tax. Fail CLOSED.
  if p_subtotal_cents is distinct from v_sum
     or coalesce(p_tax_cents, 0) < 0
     or p_total_cents is distinct from (v_sum + coalesce(p_tax_cents, 0)) then
    update public.shop_stripe_payments set outcome = 'failed' where id = v_pay_id;
    update public.shop_stripe_carts set status = 'failed' where id = p_cart_id;
    update public.shop_stripe_intents set status = 'failed' where cart_id = p_cart_id and status = 'pending';
    return jsonb_build_object('ok', false, 'reason', 'amount_mismatch', 'refund', true,
                              'payment_intent_id', p_payment_intent_id);
  end if;

  -- (5) PHASE 2 — deliver EVERY item as a GUEST order (buyer null + token + email). We still
  -- hold all the listing locks from phase 1 (same transaction), so availability cannot have
  -- changed. Each item posts balanced ledger legs keyed event_id||'#'||index (unique per item).
  for rec in
    select i.* from public.shop_stripe_intents i
     where i.cart_id = p_cart_id order by i.listing_id, i.kind
  loop
    select * into l from public.shop_listings where id = rec.listing_id;  -- already locked in phase 1
    v_fee    := round(rec.price_cents * public.shop_fee_rate());
    v_payout := rec.price_cents - v_fee;

    insert into public.shop_orders
        (listing_id, buyer_id, seller_id, kind, price_cents, fee_cents, status, guest_email, download_token)
      values (rec.listing_id, null, l.user_id, rec.kind, rec.price_cents, v_fee, 'requested', v_email, rec.download_token)
      returning * into v_order;

    perform public.ledger_post('purchase',
      jsonb_build_array(
        jsonb_build_object('user', l.user_id, 'kind', 'earnings', 'amount_cents', v_payout,
                           'available_at', now() + (public.payout_hold_days() || ' days')::interval),
        jsonb_build_object('user', null, 'kind', 'platform', 'amount_cents', v_fee),
        jsonb_build_object('user', null, 'kind', 'platform', 'amount_cents', -rec.price_cents)),
      'stripe', p_event_id || '#' || v_i, 'Beat purchase (web / guest cart)');

    update public.shop_orders
       set status = 'delivered', delivered_at = now(), fee_cents = v_fee where id = v_order.id;
    update public.shop_stripe_intents set status = 'delivered', order_id = v_order.id where id = rec.id;

    v_downloads := v_downloads || jsonb_build_array(jsonb_build_object('token', rec.download_token, 'title', l.title));
    v_i := v_i + 1;
  end loop;

  -- (6) Bank the cart's tax (one row for the whole cart; one buyer → one jurisdiction).
  if coalesce(p_tax_cents, 0) > 0 then
    insert into public.shop_tax_collected
      (cart_id, event_id, buyer_id, subtotal_cents, tax_cents, total_cents, country, state, currency)
    values (p_cart_id, p_event_id, null, v_sum, p_tax_cents, p_total_cents,
            upper(nullif(p_tax_country, '')), upper(nullif(p_tax_state, '')),
            lower(coalesce(nullif(p_currency, ''), 'usd')));
  end if;

  update public.shop_stripe_carts set status = 'delivered', guest_email = v_email where id = p_cart_id;
  update public.shop_stripe_payments set outcome = 'delivered' where id = v_pay_id;

  return jsonb_build_object('ok', true, 'delivered', true, 'cart_id', p_cart_id,
                            'items', v_i, 'tax_cents', coalesce(p_tax_cents, 0),
                            'email', v_email, 'downloads', v_downloads);
end $$;

-- Service role only — nothing client-side may deliver.
revoke all on function public.shop_deliver_stripe_guest_cart(uuid, text, text, int, int, int, text, text, text, text) from public, authenticated;


-- ─── 4) Poll (by cart id; guest cart only) ──────────────────────────────────
-- The success page polls this by the cart id (an unguessable uuid its browser got from the
-- Stripe return). Returns the per-item download tokens once the webhook has delivered — the
-- same bearer-credential model as shop_poll_stripe_guest (single).
create or replace function public.shop_poll_stripe_guest_cart(p_cart_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_cart public.shop_stripe_carts%rowtype; v_downloads jsonb;
begin
  select * into v_cart from public.shop_stripe_carts where id = p_cart_id and buyer_id is null;
  if v_cart.id is null then raise exception 'not_found'; end if;

  if v_cart.status = 'delivered' then
    select coalesce(jsonb_agg(jsonb_build_object('token', o.download_token, 'title', l.title) order by o.created_at), '[]'::jsonb)
      into v_downloads
      from public.shop_stripe_intents i
      join public.shop_orders o   on o.id = i.order_id
      join public.shop_listings l on l.id = o.listing_id
     where i.cart_id = p_cart_id and o.buyer_id is null and o.status = 'delivered';
  end if;

  return jsonb_build_object(
    'status', v_cart.status,
    'delivered', v_cart.status = 'delivered',
    'refunded', v_cart.status = 'failed',   -- a failed cart was refunded to the card
    'downloads', case when v_cart.status = 'delivered' then coalesce(v_downloads, '[]'::jsonb) else null end
  );
end $$;
grant execute on function public.shop_poll_stripe_guest_cart(uuid) to anon, authenticated;


-- ─── Revoke anon, BY NAME (the load-bearing one; see shop_stripe.sql) ────────
revoke all on function public.shop_begin_stripe_guest_cart(jsonb)                                                  from anon;
revoke all on function public.shop_deliver_stripe_guest_cart(uuid,text,text,int,int,int,text,text,text,text)       from anon;
revoke all on function public.shop_poll_stripe_guest_cart(uuid)                                                    from public;


-- ─── Checking it ────────────────────────────────────────────────────────────
--   A paid guest-cart order always has a token (NO rows):
--     select o.id from public.shop_orders o
--       join public.shop_stripe_intents i on i.order_id = o.id
--      where i.cart_id is not null and o.buyer_id is null and o.status='delivered'
--        and o.price_cents>0 and o.download_token is null;
--   Exactly one ledger tx per (event, item) (NO rows):
--     select source, external_id, count(*) from public.ledger_transactions
--      where source='stripe' and external_id like '%#%' group by 1,2 having count(*)>1;
--   No exclusive guest-cart listing sold twice (NO rows):
--     select i.listing_id, count(*) from public.shop_stripe_intents i
--       join public.shop_orders o on o.id=i.order_id
--      where o.status='delivered' and i.kind='sell' and i.cart_id is not null and o.buyer_id is null
--      group by 1 having count(*)>1;
--   Global solvency unchanged:  select * from public.ledger_verify();  -- expect 0 rows
--
-- Rollback:
--   drop function if exists public.shop_poll_stripe_guest_cart(uuid),
--     public.shop_deliver_stripe_guest_cart(uuid,text,text,int,int,int,text,text,text,text),
--     public.shop_begin_stripe_guest_cart(jsonb);
--   -- shop_stripe_carts.buyer_id stays nullable + guest_email is additive (safe to leave).
