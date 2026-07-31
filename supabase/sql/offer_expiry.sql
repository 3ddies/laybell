-- Buy-offers expire after 24 hours.
-- Run AFTER shop_offers_open.sql. Idempotent.
--
-- WHY IT HAS TO BE A REAL TRANSITION, NOT A LABEL
--   An offer holds the buyer's credits in escrow from the moment it is made
--   (shop_buy_with_credits posts buyer → platform). If expiry were only a thing
--   the app drew on a card, that money would sit in the platform account
--   forever and the buyer would be quietly short. So expiry is a status change,
--   and the existing settle trigger pays the credits back the same way a
--   decline does.
--
-- WHAT THIS ADDS
--   1. 'expired' as a shop_orders status.
--   2. shop_settle_offer refunds on it, alongside declined/cancelled.
--   3. shop_order_delivered REFUSES to deliver an offer past its 24h — which is
--      what closes the race where a seller taps Accept in the same minute the
--      sweep runs. Without it the winner would be whichever transaction got
--      there first, and the loser could be a paid-out offer the buyer had
--      already been refunded for.
--   4. expire_stale_offers(), swept every 10 minutes by pg_cron.
--
--   The app ALSO treats a still-'requested' offer past 24h as expired for
--   display, so the card reads correctly in the gap between the deadline and
--   the next sweep. That is presentation only; this file is what moves money.

do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'shop_orders') then
    raise exception 'run shop.sql and shop_multi.sql first';
  end if;
end $$;

-- How long an offer stands. One place, because the sweep, the delivery guard and
-- anything read manually all have to agree — a mismatch here is the difference
-- between a refunded buyer and a paid seller for the same offer.
create or replace function public.offer_ttl()
returns interval language sql immutable as $$ select interval '24 hours' $$;

-- ── 1. The status ─────────────────────────────────────────────────────────────

alter table public.shop_orders drop constraint if exists shop_orders_status_check;
alter table public.shop_orders add constraint shop_orders_status_check
  check (status in ('requested', 'delivered', 'declined', 'cancelled', 'refunded', 'expired'));

-- ── 2. Escrow returns on expiry ───────────────────────────────────────────────
-- Verbatim from shop_credits.sql except for 'expired' in the refund branch.

create or replace function public.shop_settle_offer()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_fee    bigint;
  v_payout bigint;
begin
  if new.kind is distinct from 'offer' then return new; end if;
  if old.status <> 'requested' then return new; end if;      -- already settled
  if new.status = old.status then return new; end if;
  if coalesce(new.price_cents, 0) <= 0 then return new; end if;

  if new.status = 'delivered' then
    v_fee    := round(new.price_cents * public.shop_fee_rate());
    v_payout := new.price_cents - v_fee;
    perform public.ledger_post(
      'purchase',
      jsonb_build_array(
        jsonb_build_object('user', null,           'kind', 'platform', 'amount_cents', -new.price_cents),
        jsonb_build_object('user', new.seller_id,  'kind', 'earnings', 'amount_cents',  v_payout,
                           'available_at', now() + (public.payout_hold_days() || ' days')::interval),
        jsonb_build_object('user', null,           'kind', 'platform', 'amount_cents',  v_fee)
      ),
      'internal', 'shop-offer-accept:' || new.id::text, 'Shop offer accepted'
    );
    new.fee_cents := v_fee;

  -- 'expired' joins these: an offer nobody answered is money the buyer never
  -- spent. Ledger entries are append-only, so this is a fresh refund posting,
  -- not an edit of the original hold.
  elsif new.status in ('declined', 'cancelled', 'expired') then
    perform public.ledger_post(
      'refund',
      jsonb_build_array(
        jsonb_build_object('user', null,          'kind', 'platform', 'amount_cents', -new.price_cents),
        jsonb_build_object('user', new.buyer_id,  'kind', 'credits',  'amount_cents',  new.price_cents)
      ),
      'internal', 'shop-offer-refund:' || new.id::text, 'Shop offer returned — declined, withdrawn or expired'
    );
  end if;

  return new;
end $$;

drop trigger if exists shop_orders_settle_offer on public.shop_orders;
create trigger shop_orders_settle_offer before update on public.shop_orders
  for each row execute function public.shop_settle_offer();

-- ── 3. An expired offer can never be accepted ─────────────────────────────────
-- Verbatim from shop_stats.sql except for the offer-age guard.

create or replace function public.shop_order_delivered()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_license text;
  v_listing_status text;
  v_kind text;
  v_exclusive boolean;
begin
  if new.status = 'delivered' and old.status <> 'delivered' then
    select license, status into v_license, v_listing_status
      from public.shop_listings where id = new.listing_id;
    -- A sold beat is gone — nothing further may deliver on it.
    if v_listing_status = 'sold' then
      raise exception 'listing_sold';
    end if;
    -- NEW. The sweep below runs on a schedule, so between the deadline and the
    -- next pass an offer is expired in fact but not yet in the table. Accepting
    -- one there would pay the seller for an offer the buyer is about to be
    -- refunded — the same money twice. The deadline, not the sweep, is what
    -- decides.
    if new.kind = 'offer' and new.created_at < now() - public.offer_ttl() then
      raise exception 'offer_expired';
    end if;
    v_kind := public.shop_order_kind(new.kind, v_license);
    -- An accepted offer IS an exclusive sale.
    v_exclusive := v_kind in ('sell', 'offer');
    new.delivered_at := now();
    update public.shop_listings
      set sales_count = sales_count + 1,
          -- Only the repeatable deals carry a tally. An exclusive sale is not a
          -- number, it is a terminal state, and `status = 'sold'` says it.
          lease_count = lease_count + (case when v_kind = 'lease' then 1 else 0 end),
          free_count  = free_count  + (case when v_kind = 'free'  then 1 else 0 end),
          updated_at  = now(),
          status = case when v_exclusive then 'sold' else status end
      where id = new.listing_id;
    if v_exclusive then
      update public.shop_orders
        set status = 'declined'
        where listing_id = new.listing_id and status = 'requested' and id <> new.id;
    end if;

  -- A refunded sale is a sale that did not happen. Without this the listing
  -- goes on advertising "3 leased" after all three have had their money back.
  elsif new.status = 'refunded' and old.status = 'delivered' then
    select license into v_license from public.shop_listings where id = new.listing_id;
    v_kind := public.shop_order_kind(new.kind, v_license);
    update public.shop_listings
      set sales_count = greatest(0, sales_count - 1),
          lease_count = greatest(0, lease_count - (case when v_kind = 'lease' then 1 else 0 end)),
          free_count  = greatest(0, free_count  - (case when v_kind = 'free'  then 1 else 0 end)),
          updated_at  = now()
      where id = new.listing_id;
  end if;
  return new;
end; $$;

drop trigger if exists shop_orders_delivered on public.shop_orders;
create trigger shop_orders_delivered before update on public.shop_orders
  for each row execute function public.shop_order_delivered();

-- ── 4. The sweep ──────────────────────────────────────────────────────────────
-- Row by row rather than one bulk UPDATE, so that a refund which fails for one
-- offer cannot roll back the refunds of every other offer in the same pass. An
-- offer that fails simply stays 'requested' and is retried in ten minutes.
--
-- SECURITY DEFINER because it changes orders on nobody's behalf — pg_cron has no
-- auth.uid(), and the RLS policies here are written around buyer_id/seller_id.

create or replace function public.expire_stale_offers()
returns int language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_count int := 0;
begin
  for r in
    select id from public.shop_orders
     where kind = 'offer'
       and status = 'requested'
       and created_at < now() - public.offer_ttl()
     order by created_at
  loop
    begin
      update public.shop_orders set status = 'expired' where id = r.id;
      v_count := v_count + 1;
    exception when others then
      raise warning 'expire_stale_offers: order % failed: %', r.id, sqlerrm;
    end;
  end loop;
  return v_count;
end $$;

-- It moves money. App users must never call it.
revoke execute on function public.expire_stale_offers() from public;
revoke execute on function public.expire_stale_offers() from authenticated;

-- ── 5. Schedule it ────────────────────────────────────────────────────────────
-- Every 10 minutes. The buyer's credits are held the whole time an offer stands,
-- so the lag between the 24h mark and the refund is worth keeping short; the
-- sweep is a single indexed scan over pending offers, which is a rounding error.
-- Re-running this file replaces the job of the same name.
create extension if not exists pg_cron;
select cron.schedule('expire-stale-offers', '*/10 * * * *', $$select public.expire_stale_offers();$$);

-- To stop the schedule later:  select cron.unschedule('expire-stale-offers');
-- To run it on demand:         select public.expire_stale_offers();

-- ── Checking it ───────────────────────────────────────────────────────────────
--   The job is registered:
--     select jobname, schedule, active from cron.job where jobname = 'expire-stale-offers';
--
--   Offers that are past due but not yet swept (should be empty within 10 min):
--     select id, created_at, now() - created_at as age from public.shop_orders
--      where kind = 'offer' and status = 'requested'
--        and created_at < now() - public.offer_ttl();
--
--   Every expired offer got its refund back (should return NO rows):
--     select o.id, o.price_cents
--       from public.shop_orders o
--      where o.kind = 'offer' and o.status = 'expired'
--        and not exists (
--          select 1 from public.ledger_transactions t
--           where t.external_id = 'shop-offer-refund:' || o.id::text);
