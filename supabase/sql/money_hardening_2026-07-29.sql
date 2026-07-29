-- MONEY HARDENING — run this BEFORE any real money moves.
-- Paste into the Supabase SQL Editor. Idempotent; safe to re-run.
-- REQUIRES: ledger.sql, ledger_spend.sql, payouts.sql, shop_credits.sql, promo_credits.sql.
--
-- An adversarial review of the money paths found that two of them let an ordinary
-- signed-in user MINT UNLIMITED MONEY, one let an unauthenticated caller do it,
-- and several silently destroyed money. None of it had run yet. This file closes
-- all of it.
--
-- ⚠️ RUN THE PRE-FLIGHT AT THE BOTTOM FIRST if this database already has
-- shop_credits.sql applied — there may be pre-existing offers to drain.


-- ════════════════════════════════════════════════════════════════════════════
-- C2. anon still had EXECUTE on every money function
-- ════════════════════════════════════════════════════════════════════════════
-- Supabase's bootstrap runs
--   alter default privileges ... grant all on functions to postgres, anon, authenticated, service_role
-- so every function created in `public` gets an EXPLICIT grant to `anon`, on top
-- of the implicit PUBLIC one. Revoking from `public` and `authenticated` does not
-- touch it.
--
-- The anon key ships inside the app bundle. `ledger_post` is the one money
-- function that never calls auth.uid() — so anyone who extracted that key could
-- POST /rest/v1/rpc/ledger_post with no JWT and post any balanced pair of legs.
-- Total compromise of the ledger, from a published string.
--
-- translation_rate_limit.sql in this same repo already got this right. The
-- pattern was known; the money files just didn't follow it.
revoke all on function public.ledger_post(text, jsonb, text, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.ledger_account(uuid, text, text)                        from public, anon, authenticated;
revoke all on function public.ledger_verify()                                          from public, anon, authenticated;
revoke all on function public.tip_post_internal(uuid, int, text, uuid, uuid)           from public, anon, authenticated;
revoke all on function public.settle_payout(uuid, text, text, text)                    from public, anon, authenticated;

-- These are meant to be callable by signed-in users, but never anonymously.
revoke all on function public.request_payout(bigint)                        from public, anon;
revoke all on function public.payout_available_cents()                      from public, anon;
revoke all on function public.shop_buy_with_credits(uuid, text, int)        from public, anon;
revoke all on function public.spotlight_buy_with_credits(text)              from public, anon;
revoke all on function public.spotlight_activate(uuid, uuid)                from public, anon;
revoke all on function public.spotlight_cancel_pending(uuid)                from public, anon;
revoke all on function public.ad_campaign_fund_with_credits(uuid, int)      from public, anon;
revoke all on function public.ad_campaign_end(uuid)                         from public, anon;
revoke all on function public.claim_free_spotlight(uuid)                    from public, anon;
revoke all on function public.refund_and_remove_listing(uuid)               from public, anon;
grant execute on function public.request_payout(bigint)                     to authenticated;
grant execute on function public.payout_available_cents()                   to authenticated;
grant execute on function public.shop_buy_with_credits(uuid, text, int)     to authenticated;
grant execute on function public.spotlight_buy_with_credits(text)           to authenticated;
grant execute on function public.spotlight_activate(uuid, uuid)             to authenticated;
grant execute on function public.spotlight_cancel_pending(uuid)             to authenticated;
grant execute on function public.ad_campaign_fund_with_credits(uuid, int)   to authenticated;
grant execute on function public.ad_campaign_end(uuid)                      to authenticated;
grant execute on function public.claim_free_spotlight(uuid)                 to authenticated;
grant execute on function public.refund_and_remove_listing(uuid)            to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- C1 + C3 + H3. shop_settle_offer trusted a client-controlled amount
-- ════════════════════════════════════════════════════════════════════════════
-- The trigger settled against `new.price_cents` — the value in the row being
-- written — and neither UPDATE policy on shop_orders constrained that column.
-- So:
--
--   1. offer $1 on any lease-only listing            → $1 escrowed
--   2. update shop_orders set status='cancelled',
--             price_cents = 2000000000               → $20,000,000 of credits
--
-- The legs still summed to zero, so ledger_post was satisfied, and the platform
-- account is allowed to go negative by design. The seller-side variant
-- (status='delivered') minted `earnings`, which is the CASHABLE balance — it
-- would have walked out through request_payout 14 days later.
--
-- It also settled offers that were never escrowed at all: shop_multi.sql shipped
-- buy-offers a day before shop_credits.sql, so any pre-existing 'requested'
-- offer was a money printer on first touch.
--
-- The fix is to stop trusting the row and read the ESCROW ITSELF. If there is no
-- escrow transaction for this order, there is nothing to settle and the trigger
-- does nothing — which closes the historical-rows hole in the same stroke.
create or replace function public.shop_settle_offer()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_escrow bigint;
  v_fee    bigint;
  v_payout bigint;
begin
  if new.kind is distinct from 'offer' then return new; end if;
  if old.status <> 'requested' then return new; end if;     -- already settled
  if new.status = old.status then return new; end if;

  -- The authority on how much was taken is the ledger, not the row. A negative
  -- credits leg keyed to this order's escrow transaction is the only thing that
  -- can be settled against.
  select -e.amount_cents into v_escrow
    from public.ledger_transactions t
    join public.ledger_entries   e on e.transaction_id = t.id
    join public.ledger_accounts  a on a.id = e.account_id
   where t.source = 'internal'
     and t.external_id = 'shop-offer:' || new.id::text
     and a.user_id = new.buyer_id
     and a.kind    = 'credits';

  -- No escrow: an offer created before credits existed, or one that never paid.
  -- Let the status change through, move no money.
  if not found or coalesce(v_escrow, 0) <= 0 then return new; end if;

  if new.status = 'delivered' then
    v_fee    := round(v_escrow * public.shop_fee_rate());
    v_payout := v_escrow - v_fee;
    perform public.ledger_post(
      'purchase',
      jsonb_build_array(
        jsonb_build_object('user', null,          'kind', 'platform', 'amount_cents', -v_escrow),
        jsonb_build_object('user', new.seller_id, 'kind', 'earnings', 'amount_cents',  v_payout,
                           'available_at', now() + (public.payout_hold_days() || ' days')::interval),
        jsonb_build_object('user', null,          'kind', 'platform', 'amount_cents',  v_fee)
      ),
      'internal', 'shop-offer-accept:' || new.id::text, 'Shop offer accepted'
    );
    new.fee_cents   := v_fee;
    new.price_cents := v_escrow;   -- pin the row back to what was actually paid

  -- 'refunded' was a legal status with no branch here, so an escrow settled that
  -- way was stranded in the platform account permanently.
  elsif new.status in ('declined', 'cancelled', 'refunded') then
    perform public.ledger_post(
      'refund',
      jsonb_build_array(
        jsonb_build_object('user', null,         'kind', 'platform', 'amount_cents', -v_escrow),
        jsonb_build_object('user', new.buyer_id, 'kind', 'credits',  'amount_cents',  v_escrow)
      ),
      'internal', 'shop-offer-refund:' || new.id::text, 'Shop offer not accepted — credits returned'
    );
    new.price_cents := v_escrow;

  else
    raise exception 'unhandled_offer_transition: % -> %', old.status, new.status;
  end if;

  return new;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- M1. shop_orders had no column immutability at all
-- ════════════════════════════════════════════════════════════════════════════
-- Same shape as ad_campaigns_guard. The RLS policies decide WHO may update a
-- row; nothing decided WHAT they may change. Beyond the price exploit above, a
-- seller could move a settled order back to 'delivered' (refund kept, file
-- delivered, sales_count corrupted).
create or replace function public.shop_orders_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.promo_trusted() then return new; end if;

  if new.listing_id is distinct from old.listing_id
     or new.buyer_id  is distinct from old.buyer_id
     or new.seller_id is distinct from old.seller_id
     or new.kind      is distinct from old.kind
     or new.fee_cents is distinct from old.fee_cents
  then
    raise exception 'protected_column';
  end if;

  -- price_cents is immutable. This works WITH shop_settle_offer rather than
  -- against it: Postgres fires same-timing triggers in NAME order, and this one
  -- is deliberately named `_z_guard` so it runs LAST. By the time it compares,
  -- shop_settle_offer has already pinned new.price_cents back to the escrowed
  -- amount — so a tampered value has been corrected and this sees no change,
  -- while a tampered value on an order with no escrow is caught here.
  if new.price_cents is distinct from old.price_cents then
    raise exception 'protected_column';
  end if;

  -- A settled order is final.
  if old.status in ('delivered', 'declined', 'cancelled', 'refunded')
     and new.status is distinct from old.status
     and not (old.status = 'delivered' and new.status = 'refunded')
  then
    raise exception 'bad_status_transition: % -> %', old.status, new.status;
  end if;

  return new;
end $$;

-- Named to sort AFTER shop_orders_a_precheck and shop_orders_delivered, and
-- after shop_orders_settle_offer, so the settle trigger's own price pin is not
-- rejected by this guard.
drop trigger if exists shop_orders_z_guard on public.shop_orders;
create trigger shop_orders_z_guard before update on public.shop_orders
  for each row execute function public.shop_orders_guard();


-- ════════════════════════════════════════════════════════════════════════════
-- M2 + M3. shop_buy_with_credits ignored listing status, and raced
-- ════════════════════════════════════════════════════════════════════════════
-- Moving to SECURITY DEFINER dropped the RLS check that required
-- `shop_listings.status = 'active'`, and shop_order_precheck never looked at it.
-- So a buyer could pay for a listing the seller had removed or paused.
--
-- The `for update` also closes a double-sale race on exclusive licences: two
-- concurrent 'sell' buys could both read status='active' and both deliver.
create or replace function public.shop_buy_with_credits(
  p_listing_id  uuid,
  p_kind        text,
  p_offer_cents int default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_buyer  uuid := auth.uid();
  v_seller uuid;
  v_status text;
  v_order  public.shop_orders%rowtype;
  v_fee    bigint;
  v_payout bigint;
  v_tx     uuid;
begin
  if v_buyer is null then raise exception 'not_signed_in'; end if;
  if p_kind not in ('sell', 'lease', 'free', 'offer') then raise exception 'bad_kind'; end if;

  -- Lock the listing for the rest of the transaction.
  select l.user_id, l.status into v_seller, v_status
    from public.shop_listings l where l.id = p_listing_id for update;
  if v_seller is null then raise exception 'listing_not_found'; end if;
  if v_status is distinct from 'active' then raise exception 'listing_not_available'; end if;
  if v_seller = v_buyer then raise exception 'cannot_buy_own'; end if;

  insert into public.shop_orders (listing_id, buyer_id, seller_id, kind, price_cents, status)
  values (
    p_listing_id, v_buyer, v_seller, p_kind,
    case when p_kind = 'offer' then coalesce(p_offer_cents, 0) else 0 end,
    'requested'
  )
  returning * into v_order;

  if p_kind = 'free' then
    return jsonb_build_object('ok', true, 'order_id', v_order.id, 'price_cents', 0, 'delivered', true);
  end if;

  v_fee    := round(v_order.price_cents * public.shop_fee_rate());
  v_payout := v_order.price_cents - v_fee;

  if p_kind = 'offer' then
    v_tx := public.ledger_post(
      'purchase',
      jsonb_build_array(
        jsonb_build_object('user', v_buyer, 'kind', 'credits',  'amount_cents', -v_order.price_cents),
        jsonb_build_object('user', null,    'kind', 'platform', 'amount_cents',  v_order.price_cents)
      ),
      'internal', 'shop-offer:' || v_order.id::text, 'Shop offer held'
    );
    perform set_config('laybell.promo_trusted', 'on', true);
    update public.shop_orders o set fee_cents = v_fee where o.id = v_order.id;
    return jsonb_build_object('ok', true, 'order_id', v_order.id,
                              'price_cents', v_order.price_cents, 'delivered', false,
                              'transaction_id', v_tx);
  end if;

  v_tx := public.ledger_post(
    'purchase',
    jsonb_build_array(
      jsonb_build_object('user', v_buyer,  'kind', 'credits',  'amount_cents', -v_order.price_cents),
      jsonb_build_object('user', v_seller, 'kind', 'earnings', 'amount_cents',  v_payout,
                         'available_at', now() + (public.payout_hold_days() || ' days')::interval),
      jsonb_build_object('user', null,     'kind', 'platform', 'amount_cents',  v_fee)
    ),
    'internal', 'shop:' || v_order.id::text, 'Shop purchase'
  );

  perform set_config('laybell.promo_trusted', 'on', true);
  update public.shop_orders o
     set status = 'delivered', delivered_at = now(), fee_cents = v_fee
   where o.id = v_order.id;

  return jsonb_build_object('ok', true, 'order_id', v_order.id,
                            'price_cents', v_order.price_cents, 'fee_cents', v_fee,
                            'seller_cents', v_payout, 'delivered', true,
                            'transaction_id', v_tx);
end $$;

grant execute on function public.shop_buy_with_credits(uuid, text, int) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- H1. refund_and_remove_listing refunded nothing
-- ════════════════════════════════════════════════════════════════════════════
-- It flipped delivered orders to 'refunded' and stopped. Its own comment said
-- "payments are simulated, so 'refund' is the status flip" — true when written,
-- false the moment shop_credits.sql made payments real. Meanwhile lib/shop.ts
-- tells the seller it "refunds every delivered buyer".
--
-- Net effect: the buyer lost file access AND their credits, the seller kept the
-- earnings, and the ledger showed a completed sale. Any seller could do this to
-- every buyer of a listing, at will.
--
-- Now it posts real reversals. If the seller cannot cover them — because the
-- earnings were already withdrawn — ledger_post refuses to settle the account
-- negative and the whole takedown rolls back. That is the correct outcome: you
-- cannot take down a listing you can no longer refund.
create or replace function public.refund_and_remove_listing(p_listing uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  r     record;
  v_fee bigint;
begin
  if v_uid is null or not exists (
    select 1 from public.shop_listings l where l.id = p_listing and l.user_id = v_uid
  ) then
    raise exception 'not_owner';
  end if;

  for r in
    select o.id, o.buyer_id, o.seller_id, o.price_cents
      from public.shop_orders o
     where o.listing_id = p_listing and o.status = 'delivered' and o.price_cents > 0
     for update
  loop
    v_fee := round(r.price_cents * public.shop_fee_rate());
    -- Buyer made whole; the seller gives back their share and Laybell gives back
    -- the fee. Idempotent, so a retried takedown cannot double-refund.
    perform public.ledger_post(
      'refund',
      jsonb_build_array(
        jsonb_build_object('user', r.buyer_id,  'kind', 'credits',  'amount_cents',  r.price_cents),
        jsonb_build_object('user', r.seller_id, 'kind', 'earnings', 'amount_cents', -(r.price_cents - v_fee)),
        jsonb_build_object('user', null,        'kind', 'platform', 'amount_cents', -v_fee)
      ),
      'internal', 'shop-takedown:' || r.id::text, 'Listing taken down — buyer refunded'
    );
  end loop;

  perform set_config('laybell.promo_trusted', 'on', true);
  update public.shop_orders o
     set status = 'refunded', refunded_at = now()
   where o.listing_id = p_listing and o.status = 'delivered';
  update public.shop_listings l
     set status = 'removed', updated_at = now()
   where l.id = p_listing;
end $$;

grant execute on function public.refund_and_remove_listing(uuid) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- H2. Unspent ad budget was destroyed on the NORMAL expiry path
-- ════════════════════════════════════════════════════════════════════════════
-- The clients lazily settle expired campaigns to 'ended' — merely opening the Ad
-- Manager or the Spotlight screen did it — and the guard permits active→ended.
-- ad_campaign_end then bailed on `status not in ('active','paused')` and refunded
-- nothing. A $100 campaign that spent $20 forfeited $80, silently, as the DEFAULT
-- outcome for any campaign that ends by schedule rather than by budget.
--
-- 'ended' is now accepted, and the refund is idempotent through its external_id,
-- so it is safe to call repeatedly on the same campaign. The client-side lazy
-- settles are removed separately in lib/ads.ts and lib/spotlight.ts.
create or replace function public.ad_campaign_end(p_campaign_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    uuid := auth.uid();
  v_camp    public.ad_campaigns%rowtype;
  v_unspent bigint;
begin
  if v_user is null then raise exception 'not_signed_in'; end if;

  select * into v_camp from public.ad_campaigns c
   where c.id = p_campaign_id and c.user_id = v_user for update;
  if not found then raise exception 'campaign_not_found'; end if;
  if v_camp.kind is distinct from 'ad' then return 0; end if;
  if v_camp.status not in ('active', 'paused', 'ended') then return 0; end if;

  v_unspent := greatest(0, coalesce(v_camp.budget_cents_total, 0) - coalesce(v_camp.spent_cents, 0));

  perform set_config('laybell.promo_trusted', 'on', true);
  if v_camp.status <> 'ended' then
    update public.ad_campaigns c set status = 'ended' where c.id = p_campaign_id;
  end if;

  if v_unspent > 0 then
    perform public.ledger_post(
      'refund',
      jsonb_build_array(
        jsonb_build_object('user', null,   'kind', 'platform', 'amount_cents', -v_unspent),
        jsonb_build_object('user', v_user, 'kind', 'credits',  'amount_cents',  v_unspent)
      ),
      'internal', 'ad-refund:' || p_campaign_id::text, 'Unspent ad budget returned'
    );
  end if;

  return v_unspent;
end $$;

grant execute on function public.ad_campaign_end(uuid) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- M4 + M6. The ad guard left post_id, kind and ends_at open
-- ════════════════════════════════════════════════════════════════════════════
-- ends_at was chosen freely by the client at INSERT and then frozen as trusted,
-- and neither post_id nor kind was protected. So: insert an ad campaign with
-- ends_at a year out, fund it with the $5 minimum, then set post_id to your own
-- post. fetchFeedSpotlights filters on status and ends_at with no `kind` filter,
-- so it serves as a Spotlight for a year. The 7-day package is $49.99.
--
-- M6: the client rolls a failed campaign back with pending→canceled, which the
-- old transition rule rejected. The error was unchecked, so the outcome was
-- accidentally correct (the row stays pending and never serves) but pending
-- orphans accumulated.
create or replace function public.ad_campaigns_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.promo_trusted() then return new; end if;

  if tg_op = 'INSERT' then
    if new.kind is distinct from 'ad' then raise exception 'spotlight_must_use_rpc'; end if;
    if coalesce(new.status, 'pending') <> 'pending' then raise exception 'must_start_pending'; end if;
    -- A client-chosen end date was frozen as trusted once funded. Cap it.
    if new.ends_at is null or new.ends_at > now() + interval '90 days' then
      raise exception 'bad_schedule';
    end if;
    new.budget_cents_total := null;
    new.spent_cents        := 0;
    new.spent_millicents   := 0;
    new.bid_cpm_cents      := null;
    new.price_cents        := 0;
    new.post_id            := null;   -- ads do not carry a post
    return new;
  end if;

  -- Spend may only ever go UP. record_ad_event accrues on every impression and
  -- knows nothing about the trusted flag; freezing these outright threw on every
  -- ad view. Monotonic targets the actual attack — resetting the meter — while
  -- leaving the budget ceiling immovable.
  if new.spent_millicents < old.spent_millicents
     or new.spent_cents   < old.spent_cents
  then
    raise exception 'protected_column';
  end if;

  if new.budget_cents_total is distinct from old.budget_cents_total
     or new.bid_cpm_cents    is distinct from old.bid_cpm_cents
     or new.price_cents      is distinct from old.price_cents
     or new.weight           is distinct from old.weight
     or new.package_key      is distinct from old.package_key
     or new.duration_days    is distinct from old.duration_days
     or new.ends_at          is distinct from old.ends_at
     or new.starts_at        is distinct from old.starts_at
     or new.kind             is distinct from old.kind
     or new.post_id          is distinct from old.post_id
  then
    raise exception 'protected_column';
  end if;

  if new.status is distinct from old.status
     and not (old.status in ('active', 'paused') and new.status in ('active', 'paused', 'ended'))
     and not (old.status = 'pending' and new.status = 'canceled')
  then
    raise exception 'bad_status_transition';
  end if;

  return new;
end $$;

drop trigger if exists ad_campaigns_guard_trg on public.ad_campaigns;
create trigger ad_campaigns_guard_trg before insert or update on public.ad_campaigns
  for each row execute function public.ad_campaigns_guard();


-- ════════════════════════════════════════════════════════════════════════════
-- M5. spotlight_cancel_pending accepted unfunded ad campaigns
-- ════════════════════════════════════════════════════════════════════════════
-- An unfunded ad is kind='ad', status='pending', price_cents=0. It passed every
-- check, then built two zero-value legs and died on ledger_entries'
-- `check (amount_cents <> 0)` — a confusing failure rather than a clean refusal.
create or replace function public.spotlight_cancel_pending(p_campaign_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_camp public.ad_campaigns%rowtype;
begin
  if v_user is null then raise exception 'not_signed_in'; end if;

  select * into v_camp from public.ad_campaigns c
   where c.id = p_campaign_id and c.user_id = v_user for update;
  if not found then raise exception 'campaign_not_found'; end if;
  if v_camp.kind is distinct from 'spotlight' then raise exception 'not_a_spotlight'; end if;
  if v_camp.status <> 'pending' then raise exception 'not_cancellable'; end if;

  perform set_config('laybell.promo_trusted', 'on', true);
  update public.ad_campaigns c set status = 'canceled' where c.id = p_campaign_id;
  update public.ad_payments  a set status = 'refunded' where a.campaign_id = p_campaign_id;

  -- The free Premium Spotlight is price 0 and has nothing to return.
  if coalesce(v_camp.price_cents, 0) > 0 then
    perform public.ledger_post(
      'refund',
      jsonb_build_array(
        jsonb_build_object('user', null,   'kind', 'platform', 'amount_cents', -v_camp.price_cents),
        jsonb_build_object('user', v_user, 'kind', 'credits',  'amount_cents',  v_camp.price_cents)
      ),
      'internal', 'spotlight-refund:' || p_campaign_id::text, 'Spotlight cancelled'
    );
  end if;
end $$;

grant execute on function public.spotlight_cancel_pending(uuid) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- PRE-FLIGHT AND VERIFICATION
-- ════════════════════════════════════════════════════════════════════════════
--
-- 1. anon must not be able to execute any of these. All five must be false:
--
--   select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon_can
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('ledger_post','ledger_account','ledger_verify',
--                        'settle_payout','tip_post_internal');
--
-- 2. Offers created before credits existed carry no escrow. The rewritten
--    trigger now ignores them rather than minting money, but they will never
--    settle either — so look and clear them by hand:
--
--   select id, buyer_id, seller_id, price_cents, created_at
--     from public.shop_orders where kind = 'offer' and status = 'requested';
--
-- 3. donation_guard v4 reads new.studio_session_id, which only exists after
--    studio_live.sql. If that was never applied, EVERY tip raises. Expect two
--    rows, with stream_id nullable:
--
--   select column_name, is_nullable from information_schema.columns
--    where table_schema = 'public' and table_name = 'donations'
--      and column_name in ('stream_id', 'studio_session_id');
--
-- 4. The books still balance — returns rows ONLY on drift:
--
--   select * from public.ledger_verify();
