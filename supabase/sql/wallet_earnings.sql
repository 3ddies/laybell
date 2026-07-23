-- ============================================================================
-- Wallet earnings — server-side sum of a seller's DELIVERED shop take-home.
--
-- FIXES AN UNDER-COUNT: the wallet balance summed delivered-order take-home on
-- the CLIENT from fetchMySales(), which is page-capped at 100 rows — so a seller
-- with >100 orders (any status) saw a balance that was too LOW. This RPC sums
-- server-side and uncapped, using the EXACT same per-order formula as
-- lib/shop.ts `sellerEarningsCents()`:  round(price_cents * (1 - 0.15)).
-- It mirrors the existing donation_earnings() RPC.
--
-- Idempotent (create or replace), no schema change, safe to run anytime.
-- The app already PREFERS this RPC and falls back to the old (page-capped)
-- client sum until it exists — so running this file is what activates the fix,
-- and until you do, behavior is exactly as it is today.
-- ============================================================================

create or replace function public.delivered_earnings()
returns table (total_cents bigint, sale_count bigint)
language sql stable security definer set search_path = public as $$
  select
    -- SHOP_FEE_RATE = 0.15 → seller keeps 85%, rounded per order (matches JS
    -- Math.round on positive values), then summed.
    coalesce(sum(round(price_cents * 0.85)), 0)::bigint,
    count(*)::bigint
  from public.shop_orders
  where seller_id = auth.uid() and status = 'delivered';
$$;

grant execute on function public.delivered_earnings() to authenticated;
