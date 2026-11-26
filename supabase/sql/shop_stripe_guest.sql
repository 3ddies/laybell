-- GUEST (no-account) card checkout for the shop via STRIPE (web only).
-- Run AFTER shop_stripe.sql (+ shop_stripe_cart.sql). Idempotent; re-runnable.
-- ⚠️ MONEY CODE — DO NOT RUN until reviewed. Built on the web-shop-checkout branch.
--
-- WHAT THIS IS
-- Lets a browser with NO Laybell account buy a beat: they pay on Stripe (which collects
-- their email), the webhook delivers to a shop_orders row that has NO buyer_id but a secret
-- download_token, and they download via that token — instant on the success page AND an
-- emailed link — no sign-up. It REUSES the exclusivity lock, the delivered trigger, the
-- ledger and the tax fund exactly as a logged-in sale; the only differences are buyer_id is
-- null and delivery is token-gated instead of auth-gated.
--
-- ⚠️ SHARED-TABLE CHANGE (flag for the money review): shop_orders.buyer_id becomes NULLABLE.
-- Verified safe: shop_order_precheck reads buyer_id only on the FREE path (guests use
-- sell/lease), shop_order_delivered never reads it, the RLS "buyers read" (buyer_id=auth.uid())
-- simply never matches a guest row (hidden from buyers, still visible to the seller via
-- seller_id), and the (listing_id,buyer_id[,kind]) unique indexes treat nulls as distinct
-- (fine: exclusives are protected by the listing lock + status, not the buyer slot). A new
-- CHECK keeps a paid order from having neither a buyer nor a token. Follow-on (not money):
-- the seller's mobile sales view should render a null buyer as "Guest".
--
-- SCOPE v1: single-item buy-now (sell/lease). Guest CART is a deliberate fast-follow.

do $$
begin
  if not exists (select 1 from pg_proc where proname = 'shop_deliver_stripe_order') then
    raise exception 'run shop_stripe.sql before shop_stripe_guest.sql';
  end if;
end $$;


-- ─── 1) Order model: allow a guest order (no account) + a download token ─────
alter table public.shop_orders alter column buyer_id drop not null;
alter table public.shop_orders add column if not exists guest_email   text;
alter table public.shop_orders add column if not exists download_token text;
create unique index if not exists shop_orders_download_token_uq
  on public.shop_orders (download_token) where download_token is not null;
-- A PAID order must have a buyer or a guest token (never neither). Free claims (price 0) keep
-- their buyer_id, so they satisfy this too.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shop_orders_buyer_or_guest') then
    alter table public.shop_orders add constraint shop_orders_buyer_or_guest
      check (buyer_id is not null or download_token is not null or coalesce(price_cents, 0) = 0);
  end if;
end $$;

-- Guest intents reuse shop_stripe_intents: buyer_id null = a GUEST intent; the token is
-- generated up front and carried to the order on delivery.
alter table public.shop_stripe_intents alter column buyer_id drop not null;
alter table public.shop_stripe_intents add column if not exists download_token text;


-- ─── 2) Begin a guest order (service role, via the public edge fn) ───────────
-- Validates the listing/kind, SETS the price server-side, records a guest intent with a fresh
-- 48-char download token. No auth.uid(); no "already owned" (guests have no history).
create or replace function public.shop_begin_stripe_guest_order(p_listing_id uuid, p_kind text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  l        public.shop_listings%rowtype;
  v_sell boolean; v_lease boolean;
  v_price  int;
  v_intent public.shop_stripe_intents%rowtype;
  v_token  text;
begin
  if p_kind not in ('sell', 'lease') then raise exception 'bad_kind'; end if;  -- free=in-app; offer=credits
  select * into l from public.shop_listings where id = p_listing_id;
  if l.id is null then raise exception 'listing_not_found'; end if;
  if l.status <> 'active' then raise exception 'listing_not_available'; end if;

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
  if v_price < 50 then raise exception 'price_below_min'; end if;

  v_token := encode(gen_random_bytes(24), 'hex');  -- 48 hex chars of CSPRNG
  insert into public.shop_stripe_intents (buyer_id, listing_id, kind, price_cents, download_token)
    values (null, p_listing_id, p_kind, v_price, v_token)
    returning * into v_intent;

  return jsonb_build_object('ok', true, 'intent_id', v_intent.id, 'price_cents', v_price);
end $$;

-- Service role only (the public shop-guest-checkout edge fn calls it); never a client role.
revoke all on function public.shop_begin_stripe_guest_order(uuid, text) from public, anon, authenticated;

create or replace function public.shop_stripe_attach_guest_session(p_intent_id uuid, p_session_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.shop_stripe_intents set session_id = p_session_id
   where id = p_intent_id and status = 'pending' and buyer_id is null;
end $$;
revoke all on function public.shop_stripe_attach_guest_session(uuid, text) from public, anon, authenticated;


-- ─── 3) Deliver a guest order (webhook / service role) ──────────────────────
-- Mirrors shop_deliver_stripe_order but with NO buyer: creates a guest shop_orders row
-- (buyer null + the token + the email Stripe collected). Validates every money condition
-- under the listing lock and returns ok:false+refund on any mismatch (never raises on a
-- business outcome), so the webhook refunds the card. Idempotent on the Stripe event id.
create or replace function public.shop_deliver_stripe_guest_order(
  p_intent_id         uuid,
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
  v_pay_id  uuid;
  v_outcome text;
  v_intent  public.shop_stripe_intents%rowtype;
  l         public.shop_listings%rowtype;
  v_sell boolean; v_lease boolean;
  v_price   int;
  v_fee     bigint;
  v_payout  bigint;
  v_order   public.shop_orders%rowtype;
begin
  if p_event_id is null then raise exception 'no_event_id'; end if;

  -- (1) Resolve the GUEST intent (buyer_id must be null — a logged-in intent never routes here).
  if p_intent_id is not null then
    select * into v_intent from public.shop_stripe_intents where id = p_intent_id and buyer_id is null for update;
  end if;
  if v_intent.id is null then
    insert into public.shop_stripe_payments (event_id, paid_cents, payment_intent_id, outcome)
      values (p_event_id, p_total_cents, p_payment_intent_id, 'failed')
      on conflict (event_id) do nothing;
    return jsonb_build_object('ok', false, 'reason', 'no_intent', 'refund', true,
                              'payment_intent_id', p_payment_intent_id);
  end if;

  -- (2) Payment-level idempotency — one economic effect per Stripe event.
  insert into public.shop_stripe_payments (event_id, buyer_id, paid_cents, payment_intent_id, session_id)
    values (p_event_id, null, p_total_cents, p_payment_intent_id, v_intent.session_id)
    on conflict (event_id) do nothing
    returning id into v_pay_id;
  if v_pay_id is null then
    select outcome into v_outcome from public.shop_stripe_payments where event_id = p_event_id;
    return jsonb_build_object('ok', v_outcome = 'delivered', 'idempotent', true, 'outcome', v_outcome,
                              'refund', v_outcome = 'failed', 'payment_intent_id', p_payment_intent_id);
  end if;

  if v_intent.status <> 'pending' then
    update public.shop_stripe_payments set outcome = 'failed' where id = v_pay_id;
    return jsonb_build_object('ok', false, 'reason', 'intent_settled', 'refund', true,
                              'payment_intent_id', p_payment_intent_id);
  end if;

  -- (3) Verify the money (subtotal == price we issued; total == subtotal + tax). Fail CLOSED.
  if p_subtotal_cents is distinct from v_intent.price_cents
     or coalesce(p_tax_cents, 0) < 0
     or p_total_cents is distinct from (v_intent.price_cents + coalesce(p_tax_cents, 0)) then
    update public.shop_stripe_payments set outcome = 'failed' where id = v_pay_id;
    update public.shop_stripe_intents set status = 'failed' where id = v_intent.id;
    return jsonb_build_object('ok', false, 'reason', 'price_mismatch', 'refund', true,
                              'payment_intent_id', p_payment_intent_id);
  end if;

  -- (4) Lock the listing and re-resolve. Only an ACTIVE listing still at the SAME price (and
  -- still offering this kind) delivers; the lock serializes against any concurrent sale of the
  -- same exclusive (guest or logged-in) — the loser reads 'sold' and is refunded.
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

  v_fee    := round(v_intent.price_cents * public.shop_fee_rate());
  v_payout := v_intent.price_cents - v_fee;

  -- (5) Deliver. Insert the GUEST order (buyer null + token + email); the precheck re-validates
  -- under the lock, and the update to 'delivered' runs the delivered-trigger that marks an
  -- exclusive listing sold + auto-declines pending requests — identical to a logged-in sale.
  insert into public.shop_orders
      (listing_id, buyer_id, seller_id, kind, price_cents, fee_cents, status, guest_email, download_token)
    values (v_intent.listing_id, null, l.user_id, v_intent.kind, v_intent.price_cents, v_fee,
            'requested', nullif(trim(p_email), ''), v_intent.download_token)
    returning * into v_order;

  perform public.ledger_post('purchase',
    jsonb_build_array(
      jsonb_build_object('user', l.user_id, 'kind', 'earnings', 'amount_cents', v_payout,
                         'available_at', now() + (public.payout_hold_days() || ' days')::interval),
      jsonb_build_object('user', null, 'kind', 'platform', 'amount_cents', v_fee),
      jsonb_build_object('user', null, 'kind', 'platform', 'amount_cents', -v_intent.price_cents)),
    'stripe', p_event_id, 'Beat purchase (web / guest)');

  update public.shop_orders set status = 'delivered', delivered_at = now(), fee_cents = v_fee where id = v_order.id;
  update public.shop_stripe_intents set status = 'delivered', order_id = v_order.id where id = v_intent.id;
  update public.shop_stripe_payments set outcome = 'delivered', order_id = v_order.id where id = v_pay_id;

  -- (6) Bank any collected sales tax (the fund), same as a logged-in sale.
  if coalesce(p_tax_cents, 0) > 0 then
    insert into public.shop_tax_collected
      (order_id, event_id, buyer_id, subtotal_cents, tax_cents, total_cents, country, state, currency)
    values (v_order.id, p_event_id, null, v_intent.price_cents, p_tax_cents, p_total_cents,
            upper(nullif(p_tax_country, '')), upper(nullif(p_tax_state, '')),
            lower(coalesce(nullif(p_currency, ''), 'usd')));
  end if;

  return jsonb_build_object('ok', true, 'delivered', true, 'order_id', v_order.id,
                            'download_token', v_intent.download_token, 'tax_cents', coalesce(p_tax_cents, 0),
                            'email', nullif(trim(p_email), ''), 'title', l.title);
end $$;

revoke all on function public.shop_deliver_stripe_guest_order(uuid, text, text, int, int, int, text, text, text, text) from public, authenticated;


-- ─── 4) Guest download + poll ───────────────────────────────────────────────
-- Resolve a delivered guest order's private file path from its token. The EDGE FN then mints a
-- short-lived signed URL (service role) — storage RLS gates logged-in buyers, but a guest has
-- no session, so the server signs on their behalf AFTER this token check. The token is the
-- credential (a 48-char CSPRNG secret, like a Gumroad download link).
create or replace function public.shop_guest_deliverable(p_token text)
returns table (order_id uuid, title text, file_path text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_token is null or length(p_token) < 24 then raise exception 'not_found'; end if;
  return query
    select o.id, l.title, l.file_path
      from public.shop_orders o
      join public.shop_listings l on l.id = o.listing_id
     where o.download_token = p_token and o.status = 'delivered' and o.buyer_id is null;
end $$;
revoke all on function public.shop_guest_deliverable(text) from public, anon, authenticated;  -- edge fn (service role) only

-- The success page polls this by intent id (which it got from checkout) to show "unlocking…"
-- then reveal the download token once the webhook has delivered. The intent id is an
-- unguessable uuid the guest's own browser holds.
create or replace function public.shop_poll_stripe_guest(p_intent_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_intent public.shop_stripe_intents%rowtype;
begin
  select * into v_intent from public.shop_stripe_intents where id = p_intent_id and buyer_id is null;
  if v_intent.id is null then raise exception 'not_found'; end if;
  return jsonb_build_object(
    'status', v_intent.status,
    'delivered', v_intent.status = 'delivered',
    'refunded', v_intent.status = 'failed',
    'download_token', case when v_intent.status = 'delivered' then v_intent.download_token else null end
  );
end $$;
grant execute on function public.shop_poll_stripe_guest(uuid) to anon, authenticated;


-- ─── Revoke anon, BY NAME (the load-bearing one; see shop_stripe.sql) ────────
revoke all on function public.shop_begin_stripe_guest_order(uuid, text)                                     from anon;
revoke all on function public.shop_stripe_attach_guest_session(uuid, text)                                  from anon;
revoke all on function public.shop_deliver_stripe_guest_order(uuid,text,text,int,int,int,text,text,text,text) from anon;
revoke all on function public.shop_guest_deliverable(text)                                                  from anon;
revoke all on function public.shop_poll_stripe_guest(uuid)                                                   from public;


-- ─── Checking it ────────────────────────────────────────────────────────────
--   A paid order always has a buyer OR a token (NO rows):
--     select id from public.shop_orders where status='delivered' and price_cents>0
--      and buyer_id is null and download_token is null;
--   No exclusive guest-sold twice (NO rows):
--     select listing_id, count(*) from public.shop_orders
--      where status='delivered' and kind='sell' and buyer_id is null group by 1 having count(*)>1;
--   Global solvency unchanged:  select * from public.ledger_verify();  -- expect 0 rows
--
-- Rollback:
--   drop function if exists public.shop_poll_stripe_guest(uuid), public.shop_guest_deliverable(text),
--     public.shop_deliver_stripe_guest_order(uuid,text,text,int,int,int,text,text,text,text),
--     public.shop_stripe_attach_guest_session(uuid,text), public.shop_begin_stripe_guest_order(uuid,text);
--   alter table public.shop_orders drop constraint if exists shop_orders_buyer_or_guest;
--   -- buyer_id stays nullable + the guest_email/download_token columns are additive (safe to leave).
