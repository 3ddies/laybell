-- ════════════════════════════════════════════════════════════════════════════
-- LAYBELL — pending migrations to run in the Supabase Dashboard → SQL Editor.
-- Paste this whole file and Run. Everything is IDEMPOTENT — safe to run more
-- than once, and safe even if some parts were already applied.
--
-- Prereq: the ORIGINAL shop.sql, live_features.sql and spotlight.sql base files
-- must already have been run (they were, earlier this project). This file only
-- carries the NEW columns/tables/policies added since.
-- ════════════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────────────────────
-- 1) SONG FEATURES — collaborator credits on audio posts (posts.features jsonb).
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.posts
  add column if not exists features jsonb not null default '[]'::jsonb;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2) LAYBELL TV — live broadcast orientation on live_streams.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.live_streams
  add column if not exists orientation text not null default 'vertical'
  check (orientation in ('vertical', 'horizontal', 'both'));


-- ─────────────────────────────────────────────────────────────────────────────
-- 3) SPOTLIGHT v2 — new package tiers (adds the 12-hour package, half-day dur).
--    12 Hours $5.99 · 1 Day $10.99 · 3 Days $24.99 · 7 Days $49.99
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.ad_campaigns drop constraint if exists ad_campaigns_package_key_check;
alter table public.ad_campaigns add constraint ad_campaigns_package_key_check
  check (package_key in ('12h', '1d', '3d', '7d'));
alter table public.ad_campaigns alter column duration_days type numeric(4, 2);


-- ─────────────────────────────────────────────────────────────────────────────
-- 4) SHOP v2 — seller economics (per-order 15% fee snapshot).
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.shop_orders add column if not exists fee_cents int not null default 0;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5) SHOP v3 — trust & safety (18+ sellers, terms consent, listing reports,
--    buy-request throttle, server-side content bounds).
-- ─────────────────────────────────────────────────────────────────────────────

-- Sellers must be adults (buying stays open to all users).
drop policy if exists "Users can open their shop" on public.shops;
create policy "Users can open their shop" on public.shops for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and coalesce(p.age, 0) >= 18
    )
  );

-- Documented seller-terms acceptance (set by the app at shop creation).
alter table public.shops add column if not exists accepted_terms_at timestamptz;

-- Listing reports — feeds the same manual-moderation queue as post/user reports.
create table if not exists public.shop_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references auth.users(id) on delete set null,
  listing_id uuid references public.shop_listings(id) on delete set null,
  seller_id uuid references auth.users(id) on delete set null,
  reason text not null,
  created_at timestamptz not null default now()
);
alter table public.shop_reports enable row level security;
drop policy if exists "Users can report listings" on public.shop_reports;
create policy "Users can report listings" on public.shop_reports for insert
  with check (auth.uid() = reporter_id);

-- Buy-request throttle: 20 requests per buyer per 24h.
create or replace function public.shop_order_rate_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare recent int;
begin
  select count(*) into recent from public.shop_orders
    where buyer_id = new.buyer_id and created_at > now() - interval '24 hours';
  if recent >= 20 then
    raise exception 'rate_limited';
  end if;
  return new;
end; $$;
drop trigger if exists shop_orders_rate_limit on public.shop_orders;
create trigger shop_orders_rate_limit before insert on public.shop_orders
  for each row execute function public.shop_order_rate_limit();

-- Server-side content bounds ($10,000 price cap, length caps).
alter table public.shop_listings drop constraint if exists shop_listings_title_len;
alter table public.shop_listings add constraint shop_listings_title_len
  check (char_length(title) <= 120);
alter table public.shop_listings drop constraint if exists shop_listings_desc_len;
alter table public.shop_listings add constraint shop_listings_desc_len
  check (description is null or char_length(description) <= 2000);
alter table public.shop_listings drop constraint if exists shop_listings_price_cap;
alter table public.shop_listings add constraint shop_listings_price_cap
  check (price_cents <= 1000000);

-- ════════════════════════════════════════════════════════════════════════════
-- Done. Reload the app; no rebuild needed (all of the above is OTA-safe).
-- ════════════════════════════════════════════════════════════════════════════
