-- Exclusivity survives concurrency: lock the listing before reading its status.
-- Run AFTER offer_expiry.sql. Idempotent.
--
-- THE AUTO-DECLINE ALREADY WORKED. shop_order_delivered declines every pending
-- order on the listing the moment an exclusive sale lands, and shop_settle_offer
-- refunds each declined offer's escrow. Nothing about that changes here.
--
-- WHAT DID NOT WORK IS THE CHECK IN FRONT OF IT.
--
--   Both functions read the listing's status with a plain SELECT. Under READ
--   COMMITTED — Postgres's default, and Supabase's — a plain SELECT sees the last
--   COMMITTED row and does not wait for a transaction that is mid-flight. So two
--   buyers hitting Buy within the same instant BOTH read status = 'active', both
--   move their credits, and both reach the delivery trigger. The second one's
--   `update shop_listings ... set status = 'sold'` blocks on the first's row lock,
--   and once the first commits the second simply proceeds — because it already
--   read 'active' and never looks again.
--
--   Result: one exclusive beat sold twice, both buyers charged, both handed the
--   file, and the listing showing a single sale. No amount of auto-declining
--   helps, because at the moment each transaction looked, there was nothing
--   pending to decline.
--
--   The same race lets a FREE CLAIM land on a listing being sold exclusively in
--   the same instant: the precheck reads 'active', delivers instantly, and the
--   exclusive sale commits alongside it.
--
-- THE FIX IS `FOR UPDATE` ON BOTH READS. The second transaction now blocks at the
-- SELECT rather than sailing past it, and when it wakes it re-reads the row and
-- sees 'sold' — so it raises and rolls back in full, credits included. That is
-- the whole change: two `for update` clauses. Everything else in both functions
-- is reproduced verbatim so this file is the complete definition of each.
--
-- Lock ordering is listing → ledger accounts in every path (the precheck takes
-- the listing lock on INSERT, before shop_buy_with_credits posts to the ledger,
-- and the delivery trigger re-takes a lock the same transaction already holds),
-- so this introduces no deadlock. Orders against a single listing serialize,
-- which is exactly the intent and costs nothing at marketplace volumes.

do $$
begin
  if not exists (select 1 from pg_proc where proname = 'offer_ttl') then
    raise exception 'run offer_expiry.sql first';
  end if;
end $$;

-- ── 1. Pre-check ──────────────────────────────────────────────────────────────

create or replace function public.shop_order_precheck()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  l public.shop_listings%rowtype;
  v_sell boolean; v_lease boolean; v_free boolean;
begin
  -- FOR UPDATE: see the header. Without it a free claim can be delivered against
  -- a listing that is being sold exclusively in the same instant.
  select * into l from public.shop_listings where id = new.listing_id for update;
  if l.id is null then
    raise exception 'listing_not_found';
  end if;

  -- Nothing may be ordered on a listing that is not on sale — sold, paused or
  -- removed. This is the only server-side thing standing between a sold-exclusive
  -- beat and a free claim on it, because a free claim is delivered right here on
  -- INSERT and never reaches the delivery trigger that refuses everything else.
  if l.status <> 'active' then
    raise exception 'listing_not_available';
  end if;

  -- Effective deal types (flag columns, else the legacy license axis).
  v_sell  := l.sell_enabled  or (not (l.sell_enabled or l.lease_enabled or l.free_enabled) and l.license = 'exclusive');
  v_lease := l.lease_enabled or (not (l.sell_enabled or l.lease_enabled or l.free_enabled) and l.license = 'nonexclusive');
  v_free  := l.free_enabled  or (not (l.sell_enabled or l.lease_enabled or l.free_enabled) and l.license = 'free');

  if new.kind = 'sell' then
    if not v_sell then raise exception 'kind_not_available'; end if;
    new.price_cents := case when l.sell_enabled then l.sell_price_cents else l.price_cents end;

  elsif new.kind = 'lease' then
    if not v_lease then raise exception 'kind_not_available'; end if;
    new.price_cents := case when l.lease_enabled then l.lease_price_cents else l.price_cents end;

  elsif new.kind = 'free' then
    if not v_free then raise exception 'kind_not_available'; end if;
    if l.free_requires_follow and not exists (
      select 1 from public.follows
      where follower_id = new.buyer_id and following_id = l.user_id
    ) then
      raise exception 'free_follow_required';
    end if;
    if coalesce(array_length(l.free_like_post_ids, 1), 0) > 0 and exists (
      select 1 from unnest(l.free_like_post_ids) as pid
      where not exists (select 1 from public.likes k where k.user_id = new.buyer_id and k.post_id = pid)
    ) then
      raise exception 'free_likes_required';
    end if;
    new.price_cents  := 0;
    new.fee_cents    := 0;
    new.status       := 'delivered';
    new.delivered_at := now();
    update public.shop_listings
      set sales_count = sales_count + 1,
          free_count  = free_count + 1,
          updated_at  = now()
      where id = new.listing_id;

  elsif new.kind = 'offer' then
    if coalesce(new.price_cents, 0) <= 0 then raise exception 'invalid_offer'; end if;
  end if;

  return new;
end; $$;

drop trigger if exists shop_orders_a_precheck on public.shop_orders;
create trigger shop_orders_a_precheck before insert on public.shop_orders
  for each row execute function public.shop_order_precheck();

-- ── 2. Delivery ───────────────────────────────────────────────────────────────

create or replace function public.shop_order_delivered()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_license text;
  v_listing_status text;
  v_kind text;
  v_exclusive boolean;
begin
  if new.status = 'delivered' and old.status <> 'delivered' then
    -- FOR UPDATE: see the header. This is the read that decides whether an
    -- exclusive sale may proceed, so it must not be allowed to see a stale
    -- 'active' while another buyer is committing one.
    select license, status into v_license, v_listing_status
      from public.shop_listings where id = new.listing_id for update;
    -- A sold beat is gone — nothing further may deliver on it.
    if v_listing_status = 'sold' then
      raise exception 'listing_sold';
    end if;
    -- The expiry sweep runs on a schedule, so between the deadline and the next
    -- pass an offer is expired in fact but not yet in the table. Accepting one
    -- there would pay the seller for an offer the buyer is about to be refunded.
    if new.kind = 'offer' and new.created_at < now() - public.offer_ttl() then
      raise exception 'offer_expired';
    end if;
    v_kind := public.shop_order_kind(new.kind, v_license);
    -- An accepted offer IS an exclusive sale.
    v_exclusive := v_kind in ('sell', 'offer');
    new.delivered_at := now();
    update public.shop_listings
      set sales_count = sales_count + 1,
          lease_count = lease_count + (case when v_kind = 'lease' then 1 else 0 end),
          free_count  = free_count  + (case when v_kind = 'free'  then 1 else 0 end),
          updated_at  = now(),
          status = case when v_exclusive then 'sold' else status end
      where id = new.listing_id;
    -- Everything still pending on this listing dies with the sale — offers
    -- included, and shop_settle_offer returns each of their escrows. A LEASE or
    -- FREE delivery deliberately does not do this: neither ends exclusivity, so
    -- an open offer to buy the beat outright is still a live proposition.
    if v_exclusive then
      update public.shop_orders
        set status = 'declined'
        where listing_id = new.listing_id and status = 'requested' and id <> new.id;
    end if;

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

-- ── Checking it ───────────────────────────────────────────────────────────────
--   Both locks are in place (expect 2):
--     select count(*) from pg_proc
--      where proname in ('shop_order_precheck', 'shop_order_delivered')
--        and prosrc like '%for update%';
--
--   No listing was ever sold twice (should return NO rows):
--     select listing_id, count(*)
--       from public.shop_orders
--      where status = 'delivered' and kind in ('sell', 'offer')
--      group by listing_id having count(*) > 1;
--
--   No sold listing still has something pending (should return NO rows):
--     select o.id, o.kind, o.status
--       from public.shop_orders o
--       join public.shop_listings l on l.id = o.listing_id
--      where l.status = 'sold' and o.status = 'requested';
--
--   Every auto-declined offer got its escrow back (should return NO rows):
--     select o.id from public.shop_orders o
--      where o.kind = 'offer' and o.status = 'declined'
--        and not exists (select 1 from public.ledger_transactions t
--                         where t.external_id = 'shop-offer-refund:' || o.id::text);
