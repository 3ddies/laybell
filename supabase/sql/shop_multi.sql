-- Shop multi-type listings — a listing can offer ANY COMBINATION of deals,
-- each with its own price and CTA button:
--   SELL  (exclusive buy-out)  → "Buy" button
--   LEASE (non-exclusive copy) → "Lease" button
--   FREE  (claim)              → "Free (Claim now)" button
-- Run AFTER shop.sql. Idempotent.
--
-- Also adds:
--   * FREE-UNLOCK CONDITIONS — the seller can require following them and/or
--     liking specific posts (any number) before a free claim goes through;
--     conditions are enforced SERVER-SIDE and a valid claim delivers
--     INSTANTLY (no seller action needed).
--   * BUY-OFFERS — on lease-only listings a buyer can offer to buy the beat
--     outright at their own price; accepting (delivering) the offer executes
--     an exclusive sale.
--   * EXCLUSIVITY — an exclusive purchase (sell or accepted offer) marks the
--     listing 'sold', auto-declines every pending request, and blocks any
--     further deliveries. Leases keep selling until that happens.
--   * TAKEDOWN PROTECTION — a listing with delivered purchases cannot be
--     removed; the only path is refund_and_remove_listing(), which refunds
--     every buyer first (refunded orders lose file access via the existing
--     storage policy, and drop out of wallet earnings automatically).
--
-- The legacy single-axis columns (license, price_cents) stay and are kept
-- mirrored by the app for old clients; pre-flag rows fall back to them.

do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'shop_listings') then
    raise exception 'Run shop.sql before shop_multi.sql (public.shop_listings is missing).';
  end if;
end $$;

-- ── 1. Listing: per-type flags + prices + free-unlock conditions ──────────────

alter table public.shop_listings add column if not exists sell_enabled boolean not null default false;
alter table public.shop_listings add column if not exists sell_price_cents int not null default 0 check (sell_price_cents >= 0);
alter table public.shop_listings add column if not exists lease_enabled boolean not null default false;
alter table public.shop_listings add column if not exists lease_price_cents int not null default 0 check (lease_price_cents >= 0);
alter table public.shop_listings add column if not exists free_enabled boolean not null default false;
alter table public.shop_listings add column if not exists free_requires_follow boolean not null default false;
alter table public.shop_listings add column if not exists free_like_post_ids uuid[] not null default '{}';

-- Same $10k cap as the legacy price column (shop.sql v3).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shop_listings_sell_price_cap') then
    alter table public.shop_listings add constraint shop_listings_sell_price_cap check (sell_price_cents <= 1000000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shop_listings_lease_price_cap') then
    alter table public.shop_listings add constraint shop_listings_lease_price_cap check (lease_price_cents <= 1000000);
  end if;
end $$;

-- Backfill existing single-axis rows into flags (only rows with no flags yet,
-- so re-running never clobbers a seller's later multi-type edits).
update public.shop_listings set
  sell_enabled  = (license = 'exclusive'),
  sell_price_cents  = case when license = 'exclusive' then price_cents else 0 end,
  lease_enabled = (license = 'nonexclusive'),
  lease_price_cents = case when license = 'nonexclusive' then price_cents else 0 end,
  free_enabled  = (license = 'free')
where not (sell_enabled or lease_enabled or free_enabled);

-- ── 2. Orders: deal kind + refunds + one-order-per-kind ───────────────────────

alter table public.shop_orders add column if not exists kind text
  check (kind in ('sell', 'lease', 'free', 'offer'));
alter table public.shop_orders add column if not exists refunded_at timestamptz;

-- Status gains 'refunded' (the takedown escape hatch).
alter table public.shop_orders drop constraint if exists shop_orders_status_check;
alter table public.shop_orders add constraint shop_orders_status_check
  check (status in ('requested', 'delivered', 'declined', 'cancelled', 'refunded'));

-- A buyer can now hold one order PER KIND on a listing (lease it, then later
-- buy it). Legacy NULL kinds collapse to one slot via the coalesce.
alter table public.shop_orders drop constraint if exists shop_orders_listing_id_buyer_id_key;
drop index if exists shop_orders_listing_buyer_kind_uq;
create unique index shop_orders_listing_buyer_kind_uq
  on public.shop_orders (listing_id, buyer_id, coalesce(kind, 'legacy'));

-- Sellers may also refund a delivered order (single-order refunds; bulk
-- refunds happen via refund_and_remove_listing below).
drop policy if exists "Sellers can fulfil" on public.shop_orders;
create policy "Sellers can fulfil" on public.shop_orders for update
  using (auth.uid() = seller_id)
  with check (auth.uid() = seller_id and status in ('delivered', 'declined', 'refunded'));

-- ── 3. Order pre-check: kind validity, free-unlock conditions, offers ─────────
-- BEFORE INSERT. Free claims that pass their conditions deliver INSTANTLY
-- (status forced to 'delivered' + sales_count bumped here, since the delivery
-- trigger below only watches updates).

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
      set sales_count = sales_count + 1, updated_at = now()
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

-- ── 4. Delivery bookkeeping v2: exclusivity ───────────────────────────────────
-- An exclusive purchase = a delivered 'sell' order or an ACCEPTED (delivered)
-- 'offer'. It marks the listing sold, auto-declines all pending requests, and
-- no further order on the listing can ever deliver. Leases/frees keep flowing
-- until that moment. Legacy NULL-kind orders keep the old license semantics.

create or replace function public.shop_order_delivered()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_license text;
  v_listing_status text;
  v_exclusive boolean;
begin
  if new.status = 'delivered' and old.status <> 'delivered' then
    select license, status into v_license, v_listing_status
      from public.shop_listings where id = new.listing_id;
    -- A sold beat is gone — nothing further may deliver on it.
    if v_listing_status = 'sold' then
      raise exception 'listing_sold';
    end if;
    v_exclusive := (new.kind in ('sell', 'offer'))
                or (new.kind is null and v_license = 'exclusive');
    new.delivered_at := now();
    update public.shop_listings
      set sales_count = sales_count + 1,
          updated_at = now(),
          status = case when v_exclusive then 'sold' else status end
      where id = new.listing_id;
    if v_exclusive then
      update public.shop_orders
        set status = 'declined'
        where listing_id = new.listing_id and status = 'requested' and id <> new.id;
    end if;
  end if;
  return new;
end; $$;
drop trigger if exists shop_orders_delivered on public.shop_orders;
create trigger shop_orders_delivered before update on public.shop_orders
  for each row execute function public.shop_order_delivered();

-- ── 5. Takedown protection ────────────────────────────────────────────────────
-- A listing with DELIVERED purchases cannot be removed (refunded ones don't
-- block — refunding IS the escape hatch). Hard DELETE is blocked whenever any
-- purchase (delivered or refunded) ever existed, so purchase/refund history
-- can never be cascaded away.

create or replace function public.shop_listing_takedown_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.shop_orders
               where listing_id = old.id and status in ('delivered', 'refunded')) then
      raise exception 'has_purchases';
    end if;
    return old;
  end if;
  if new.status = 'removed' and old.status <> 'removed' then
    if exists (select 1 from public.shop_orders
               where listing_id = old.id and status = 'delivered') then
      raise exception 'has_purchases';
    end if;
  end if;
  return new;
end; $$;
drop trigger if exists shop_listings_takedown on public.shop_listings;
create trigger shop_listings_takedown before update or delete on public.shop_listings
  for each row execute function public.shop_listing_takedown_guard();

-- The one legitimate way to take down a purchased listing: refund every
-- delivered buyer, then remove. (Payments are simulated, so "refund" is the
-- status flip — buyers immediately lose file access via the storage policy
-- and the seller's wallet earnings drop the orders automatically.)
create or replace function public.refund_and_remove_listing(p_listing uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not exists (
    select 1 from public.shop_listings where id = p_listing and user_id = v_uid
  ) then
    raise exception 'not_owner';
  end if;
  update public.shop_orders
    set status = 'refunded', refunded_at = now()
    where listing_id = p_listing and status = 'delivered';
  update public.shop_listings
    set status = 'removed', updated_at = now()
    where id = p_listing;
end; $$;
grant execute on function public.refund_and_remove_listing(uuid) to authenticated;
