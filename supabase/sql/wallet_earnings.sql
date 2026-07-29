-- ============================================================================
-- Wallet earnings — server-side sum of a seller's DELIVERED shop take-home.
--
-- FIXES AN UNDER-COUNT: the wallet balance summed delivered-order take-home on
-- the CLIENT from fetchMySales(), which is page-capped at 100 rows — so a seller
-- with >100 orders (any status) saw a balance that was too LOW. This RPC sums
-- server-side and uncapped, using the EXACT same per-order formula as
-- lib/shop.ts `sellerEarningsCents()`.
-- It mirrors the existing donation_earnings() RPC.
--
-- ⚠️ RE-RUN REQUIRED. This file was applied on 2026-07-28 with the fee hardcoded
--    as `* 0.85`, then changed on 2026-07-29 to derive from shop_fee_rate() when
--    the fee moved to 30%. Until it is re-run, the deployed function still uses
--    the old rate and every seller sees 15 points MORE than they actually earned.
--    _VERIFY_MONEY_2026-07-29.sql tests exactly this.
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
    -- Derived from shop_fee_rate(), never a hardcoded rate. This was `* 0.85`
    -- for a 15% fee, and stayed 0.85 when the fee moved to 30% — so every seller
    -- was shown 15 points of gross MORE than they had actually earned, and would
    -- have discovered the real number at payout. Rounded per order to match the
    -- client's Math.round, then summed.
    coalesce(sum(round(price_cents * (1 - public.shop_fee_rate()))), 0)::bigint,
    count(*)::bigint
  from public.shop_orders
  where seller_id = auth.uid() and status = 'delivered';
$$;

grant execute on function public.delivered_earnings() to authenticated;
