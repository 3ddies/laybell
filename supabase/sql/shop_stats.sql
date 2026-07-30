-- Shop listing stats — per-kind counters, and a real close-off once sold.
-- Run AFTER shop_multi.sql and shop_credits.sql. Idempotent.
--
-- WHY
--   A listing carried one undifferentiated `sales_count`, so the page could
--   only ever say "5 sold" — whether that was five leases, five free claims, or
--   one exclusive sale. It now counts the two REPEATABLE deals separately
--   ("3 claimed", "2 leased"), while the exclusive sale is deliberately not a
--   count at all: it happens once, ends the listing, and reads "Sold".
--
-- IT ALSO CLOSES TWO HOLES, both of them the same missing check: neither
-- shop_order_precheck() nor shop_buy_with_credits() ever looked at the
-- listing's STATUS.
--
--   * A PAUSED listing could still be bought outright. Pausing was purely
--     cosmetic — the app hid the buttons, and the server honoured any order
--     that arrived regardless.
--
--   * A SOLD listing could still be CLAIMED FOR FREE. Sell and lease on a sold
--     listing already failed safely (shop_order_delivered raises 'listing_sold'
--     and the whole RPC rolls back, money included), but a free claim is
--     inserted straight as 'delivered' by the precheck and so never passes
--     through that trigger — meaning the file could still be handed out after
--     exclusivity had been sold.
--
--   One guard in the precheck covers every kind, because every order of every
--   kind is INSERTed and therefore passes through it — including the ones
--   shop_buy_with_credits inserts on the caller's behalf.

do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'shop_listings') then
    raise exception 'run shop.sql and shop_multi.sql first';
  end if;
end $$;

-- ── 1. The counters ───────────────────────────────────────────────────────────
-- sales_count stays as it is: it is the popularity signal the browse sort runs
-- on, and it wants the undifferentiated total.

alter table public.shop_listings
  add column if not exists lease_count int not null default 0,
  add column if not exists free_count  int not null default 0;

-- ── 2. Legacy kind resolution ─────────────────────────────────────────────────
-- Orders predating shop_multi.sql have a NULL kind and are described only by
-- the listing's license. Three places need that mapping, so it lives in one.

create or replace function public.shop_order_kind(p_kind text, p_license text)
returns text language sql immutable as $$
  select coalesce(p_kind, case p_license
    when 'nonexclusive' then 'lease'
    when 'free'         then 'free'
    else                     'sell'
  end);
$$;

-- ── 3. Pre-check: the status guard, and free claims counted ───────────────────
-- Unchanged from shop_multi.sql except for the two blocks marked NEW.

create or replace function public.shop_order_precheck()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  l public.shop_listings%rowtype;
  v_sell boolean; v_lease boolean; v_free boolean;
begin
  select * into l from public.shop_listings where id = new.listing_id;
  if l.id is null then
    raise exception 'listing_not_found';
  end if;

  -- NEW. Nothing may be ordered on a listing that is not on sale — sold,
  -- paused or removed. This is the only server-side thing standing between a
  -- sold-exclusive beat and a free claim on it, because a free claim is
  -- delivered right here on INSERT and never reaches the delivery trigger that
  -- refuses everything else.
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
    -- Unlock conditions (server-enforced; the app pre-checks for nice UX).
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
    -- Conditions met → instant claim.
    new.price_cents  := 0;
    new.fee_cents    := 0;
    new.status       := 'delivered';
    new.delivered_at := now();
    update public.shop_listings
      set sales_count = sales_count + 1,
          free_count  = free_count + 1,   -- NEW
          updated_at  = now()
      where id = new.listing_id;

  elsif new.kind = 'offer' then
    -- Offers exist so lease-only beats can still change hands outright.
    if not (v_lease and not v_sell) then raise exception 'offers_not_available'; end if;
    if coalesce(new.price_cents, 0) <= 0 then raise exception 'invalid_offer'; end if;
  end if;

  return new;
end; $$;

drop trigger if exists shop_orders_a_precheck on public.shop_orders;
create trigger shop_orders_a_precheck before insert on public.shop_orders
  for each row execute function public.shop_order_precheck();

-- ── 4. Delivery bookkeeping: per-kind counts, and refunds that count back ─────
-- Unchanged from shop_multi.sql except for the counters and the refund branch.

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
  -- greatest(0, …) because these counters are also backfilled below, and a
  -- counter that can go negative is worse than one that is merely stale.
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

-- ── 5. Backfill ───────────────────────────────────────────────────────────────
-- Counts only orders that are STILL delivered, so a refunded one is absent
-- rather than subtracted — which is the same answer the triggers now converge
-- on. Safe to re-run: it assigns, it does not add.

update public.shop_listings l
   set lease_count = coalesce(c.leased, 0),
       free_count  = coalesce(c.claimed, 0)
  from (
    select o.listing_id,
           count(*) filter (where public.shop_order_kind(o.kind, li.license) = 'lease') as leased,
           count(*) filter (where public.shop_order_kind(o.kind, li.license) = 'free')  as claimed
      from public.shop_orders o
      join public.shop_listings li on li.id = o.listing_id
     where o.status = 'delivered'
     group by o.listing_id
  ) c
 where c.listing_id = l.id;

-- ── Checking it ───────────────────────────────────────────────────────────────
--   Counters against the orders they claim to describe (returns rows ONLY on
--   drift):
--
--   count(o.id), NOT count(*) — the join is a LEFT one, so a listing with no
--   delivered orders still produces a null-extended row, and count(*) counts it.
--   The filter does not save you: shop_order_kind(NULL, license) coalesces the
--   null kind into the LICENSE-derived kind, so that phantom row passes
--   `= 'lease'` on any nonexclusive listing and the check reports drift on
--   listings that have never sold anything. count(o.id) ignores the null.
--   (The backfill above joins INNER and so was never exposed to this.)
--
--     select l.id, l.title, l.lease_count, l.free_count,
--            count(o.id) filter (where public.shop_order_kind(o.kind, l.license) = 'lease') as real_leased,
--            count(o.id) filter (where public.shop_order_kind(o.kind, l.license) = 'free')  as real_claimed
--       from public.shop_listings l
--       left join public.shop_orders o
--         on o.listing_id = l.id and o.status = 'delivered'
--      group by l.id, l.title, l.lease_count, l.free_count, l.license
--     having l.lease_count <> count(o.id) filter (where public.shop_order_kind(o.kind, l.license) = 'lease')
--         or l.free_count  <> count(o.id) filter (where public.shop_order_kind(o.kind, l.license) = 'free');
--
--   Sold listings that somehow still have an open order:
--     select o.* from public.shop_orders o
--       join public.shop_listings l on l.id = o.listing_id
--      where l.status = 'sold' and o.status = 'requested';
