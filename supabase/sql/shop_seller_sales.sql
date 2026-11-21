-- Seller-level paid-sales total for the PUBLIC storefront.
--
-- WHY. The visitor-facing shop page summed paidSalesCount over the seller's
-- ACTIVE listings only. An exclusive sale flips its listing to status='sold',
-- and the shop_listings SELECT policy ("Active listings are public":
-- status = 'active' OR user_id = auth.uid()) hides every non-active row from
-- everyone but the owner. So a visitor could never see — let alone count — a
-- sold-exclusive's sale, and a seller with a real sale read "0 sales" to
-- visitors. (Leases keep the listing active, so they already counted; this is
-- specifically the sold-exclusive hole, plus any lease on a later-paused listing.)
--
-- This SECURITY DEFINER function counts across ALL the seller's non-removed
-- listings (bypassing that RLS), using the exact formula the UI already uses:
-- sales_count - free_count (a free claim is not a sale — nothing changed hands).
-- Those per-listing counters are maintained live by the delivery / precheck /
-- refund triggers in shop_stats.sql, so this total reflects a sell or lease the
-- moment it delivers and is backed out on refund. It is READ-ONLY — it changes
-- no money state and touches no counters.
--
-- Gated to OPEN shops, matching the "Open shops are public" policy: a closed or
-- nonexistent shop returns 0 rather than leaking a private seller's activity.
-- The result is the same number already shown publicly on the storefront, so it
-- is safe for signed-out (web) callers too.
--
-- Idempotent. Run AFTER shop.sql, shop_multi.sql and shop_stats.sql:
--   npx supabase db query --linked -f supabase/sql/shop_seller_sales.sql

create or replace function public.shop_seller_paid_sales(p_user uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (select 1 from public.shops s where s.user_id = p_user and s.is_open)
    then coalesce((
      select sum(greatest(0, sales_count - free_count))
        from public.shop_listings
       where user_id = p_user and status <> 'removed'
    ), 0)::int
    else 0
  end;
$$;

-- A public storefront stat for open shops — allow signed-in AND signed-out callers.
grant execute on function public.shop_seller_paid_sales(uuid) to anon, authenticated;
