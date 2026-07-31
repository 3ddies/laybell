-- Buy-offers on any active listing.
-- Run AFTER shop_stats.sql (which this supersedes for shop_order_precheck).
-- Idempotent.
--
-- WHY
--   Offers were restricted to lease-without-sell, on the reasoning that a beat
--   you can already buy outright needs no offer. That reasoning does not hold:
--
--     * On a listing WITH a Buy button, an offer is how a buyer names a price
--       BELOW the asking one. That is the whole point of "or best offer", and
--       refusing it just loses the sale silently.
--     * On a FREE-only listing, an offer is how someone buys exclusivity on
--       something being given away — the seller is free to decline, but the
--       conversation should be possible.
--
--   So the deal types no longer gate it. The listing being ACTIVE is the only
--   condition that matters, and shop_stats.sql already enforces that for every
--   kind a few lines above.
--
-- NOTHING ABOUT THE MONEY CHANGES. Offer credits are held in escrow at offer
-- time by shop_buy_with_credits (buyer → platform) and settled by
-- shop_settle_offer on the seller's answer (platform → seller on accept,
-- platform → buyer on decline). None of that reads the listing's deal types, so
-- widening who may offer does not widen anything financial. Accepting is still
-- an exclusive sale: shop_order_delivered marks the listing sold and
-- auto-declines every other pending request on it.
--
-- This is the ONLY change from the shop_stats.sql version of this function; the
-- rest is reproduced verbatim so this file remains the whole definition.

do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'shop_listings'
                   and column_name = 'free_count') then
    raise exception 'run shop_stats.sql first';
  end if;
end $$;

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
          free_count  = free_count + 1,
          updated_at  = now()
      where id = new.listing_id;

  elsif new.kind = 'offer' then
    -- CHANGED. Was `if not (v_lease and not v_sell) then raise 'offers_not_available'`.
    -- Any active listing may be offered on now; see the header. A price is still
    -- required, because an offer of nothing is not an offer.
    if coalesce(new.price_cents, 0) <= 0 then raise exception 'invalid_offer'; end if;
  end if;

  return new;
end; $$;

drop trigger if exists shop_orders_a_precheck on public.shop_orders;
create trigger shop_orders_a_precheck before insert on public.shop_orders
  for each row execute function public.shop_order_precheck();

-- ── Checking it ───────────────────────────────────────────────────────────────
--   The restriction is gone (returns no rows):
--     select 1 from pg_proc
--      where proname = 'shop_order_precheck'
--        and prosrc like '%offers_not_available%';
--
--   And the status guard is still there (returns one row):
--     select 1 from pg_proc
--      where proname = 'shop_order_precheck'
--        and prosrc like '%listing_not_available%';
