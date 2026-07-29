-- Rate change only. Paste into the Supabase SQL Editor and run.
-- Safe to re-run. Nothing else in the schema is touched.
--
-- WHY: Laybell pays Apple's STANDARD 30% commission until App Store Small
-- Business Program enrolment is approved. Every rate was set assuming the 15%
-- Small Business rate, which made two surfaces lose money on every transaction:
--
--                          Apple 30%                Apple 15%
--   $10 shop sale     receives $7.00, owed $7.50    receives $8.50, owed $7.50
--                              −$0.50                        +$1.00
--   $10 Premium tip   receives $7.00, owed $8.00    receives $8.50, owed $8.00
--                              −$1.00                        +$0.50
--
-- Both fees go to 30%, which is exactly break-even at a 30% commission: the
-- payee receives 70%, and 70% is what Laybell has left after the store takes its
-- cut. Standard tips (35%) were always safe and are unchanged.
--
-- ⚠️ REVERSE THIS AFTER SMALL BUSINESS APPROVAL. At Apple 15% these rates net
-- 15% each, which is more than either surface needs, and the extra is better
-- spent on creators than banked. Suggested: shop 0.25 (seller keeps 75%),
-- Premium tips 0.20 (creator keeps 80%). Also set STORE_COMMISSION_RATE and
-- SHOP_FEE_RATE in lib/shop.ts, and DONATION_FEE_RATE_PREMIUM in
-- lib/donations.ts, so the app stops showing the wrong split.

-- Shop: 25% → 30%. Seller keeps 70%.
create or replace function public.shop_fee_rate()
returns numeric language sql immutable as $$ select 0.30 $$;

-- Tips: Premium 20% → 30%. Creator keeps 70%. Standard stays 35%.
--
-- donation_guard v4 reads this function rather than deriving its own rate, so
-- the legacy insert path follows automatically and cannot drift.
create or replace function public.tip_fee_rate(p_host uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select case
    when coalesce((select premium_until from public.profiles where id = p_host), 'epoch'::timestamptz) > now()
    then 0.30 else 0.35
  end;
$$;


-- ─── Verify ─────────────────────────────────────────────────────────────────
--   select public.shop_fee_rate();            -- 0.30
--   select public.tip_fee_rate(null::uuid);   -- 0.35  (null host = not Premium)
--
-- Neither surface can now pay out more than Laybell received:
--   select 'shop'    as surface, 1000 - round(1000 * public.shop_fee_rate()) as owed_cents
--   union all
--   select 'premium', 1000 - round(1000 * 0.30)
--   union all
--   select 'standard',1000 - round(1000 * 0.35);
--   -- owed must be <= 700 on a 1000-cent sale while Apple takes 30%
