-- Shop — a Facebook-Marketplace-style storefront for DIGITAL goods (beats,
-- songs, sample packs…). Each user may open one shop; listings carry a public
-- cover + audio preview and a PRIVATE deliverable file. Buying follows the
-- marketplace model: a buyer sends a buy request (and typically DMs the seller
-- to settle payment), the seller "delivers", and delivery unlocks the private
-- file for that buyer via storage RLS. sales_count is trigger-maintained.
--
-- Run manually in the Supabase Dashboard → SQL Editor.

create extension if not exists pgcrypto; -- gen_random_uuid()

-- 1) Shops -------------------------------------------------------------------------

create table if not exists public.shops (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  bio text,
  is_open boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.shops enable row level security;

drop policy if exists "Open shops are public" on public.shops;
create policy "Open shops are public" on public.shops for select
  using (is_open or user_id = auth.uid());
drop policy if exists "Users can open their shop" on public.shops;
create policy "Users can open their shop" on public.shops for insert
  with check (auth.uid() = user_id);
drop policy if exists "Owners manage their shop" on public.shops;
create policy "Owners manage their shop" on public.shops for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Owners can close their shop" on public.shops;
create policy "Owners can close their shop" on public.shops for delete
  using (auth.uid() = user_id);

-- 2) Listings ----------------------------------------------------------------------

create table if not exists public.shop_listings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  description text,
  category text not null default 'beat'
    check (category in ('beat', 'song', 'sample_pack', 'preset', 'service', 'other')),
  genre text,
  price_cents int not null default 0 check (price_cents >= 0),
  currency text not null default 'USD',
  -- 'exclusive' = one buyer then sold; 'nonexclusive'/'free' = unlimited copies.
  license text not null default 'nonexclusive'
    check (license in ('exclusive', 'nonexclusive', 'free')),
  cover_url text,
  preview_url text,
  -- Path inside the PRIVATE 'shop-files' bucket: <seller_id>/<listing_id>/<file>.
  -- Never a public URL; buyers read it through the delivered-order storage policy.
  file_path text,
  status text not null default 'active'
    check (status in ('active', 'paused', 'sold', 'removed')),
  sales_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists shop_listings_explore_idx on public.shop_listings(status, created_at desc);
create index if not exists shop_listings_user_idx on public.shop_listings(user_id, created_at desc);
create index if not exists shop_listings_category_idx on public.shop_listings(category) where status = 'active';

alter table public.shop_listings enable row level security;

drop policy if exists "Active listings are public" on public.shop_listings;
create policy "Active listings are public" on public.shop_listings for select
  using (status = 'active' or user_id = auth.uid());
drop policy if exists "Sellers create listings" on public.shop_listings;
create policy "Sellers create listings" on public.shop_listings for insert
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.shops s where s.user_id = auth.uid())
  );
drop policy if exists "Sellers manage listings" on public.shop_listings;
create policy "Sellers manage listings" on public.shop_listings for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Sellers delete listings" on public.shop_listings;
create policy "Sellers delete listings" on public.shop_listings for delete
  using (auth.uid() = user_id);

-- 3) Orders (buy requests → delivery) -----------------------------------------------

create table if not exists public.shop_orders (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.shop_listings(id) on delete cascade,
  buyer_id uuid not null references auth.users(id) on delete cascade,
  seller_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'requested'
    check (status in ('requested', 'delivered', 'declined', 'cancelled')),
  -- Price snapshot at request time, so a later listing edit can't change a deal.
  price_cents int not null,
  -- Laybell's 15% cut, snapshotted at order time (lib/shop.ts SHOP_FEE_RATE).
  fee_cents int not null default 0,
  currency text not null default 'USD',
  note text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  unique (listing_id, buyer_id)
);
create index if not exists shop_orders_seller_idx on public.shop_orders(seller_id, created_at desc);
create index if not exists shop_orders_buyer_idx on public.shop_orders(buyer_id, created_at desc);

alter table public.shop_orders enable row level security;

drop policy if exists "Parties can view orders" on public.shop_orders;
create policy "Parties can view orders" on public.shop_orders for select
  using (auth.uid() = buyer_id or auth.uid() = seller_id);
-- Buyer files the request; seller_id must genuinely own an ACTIVE listing.
drop policy if exists "Buyers can request" on public.shop_orders;
create policy "Buyers can request" on public.shop_orders for insert
  with check (
    auth.uid() = buyer_id
    and buyer_id <> seller_id
    and exists (
      select 1 from public.shop_listings l
      where l.id = listing_id and l.user_id = seller_id and l.status = 'active'
    )
  );
-- Buyer may cancel a pending request; seller may deliver or decline.
drop policy if exists "Buyers can cancel" on public.shop_orders;
create policy "Buyers can cancel" on public.shop_orders for update
  using (auth.uid() = buyer_id and status = 'requested')
  with check (auth.uid() = buyer_id and status = 'cancelled');
drop policy if exists "Sellers can fulfil" on public.shop_orders;
create policy "Sellers can fulfil" on public.shop_orders for update
  using (auth.uid() = seller_id)
  with check (auth.uid() = seller_id and status in ('delivered', 'declined'));

-- Delivery bookkeeping: stamp delivered_at, bump sales_count, and auto-mark an
-- exclusive listing sold (its one copy is gone).
create or replace function public.shop_order_delivered()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'delivered' and old.status <> 'delivered' then
    new.delivered_at := now();
    update public.shop_listings
      set sales_count = sales_count + 1,
          updated_at = now(),
          status = case when license = 'exclusive' then 'sold' else status end
      where id = new.listing_id;
  end if;
  return new;
end; $$;
drop trigger if exists shop_orders_delivered on public.shop_orders;
create trigger shop_orders_delivered before update on public.shop_orders
  for each row execute function public.shop_order_delivered();

-- 4) Storage -----------------------------------------------------------------------
-- Two buckets: 'shop' (PUBLIC covers + audio previews) and 'shop-files'
-- (PRIVATE deliverables). Objects are named <seller_id>/<listing_id>/<file>.

insert into storage.buckets (id, name, public)
  values ('shop', 'shop', true)
  on conflict (id) do nothing;
insert into storage.buckets (id, name, public)
  values ('shop-files', 'shop-files', false)
  on conflict (id) do nothing;

-- Public bucket: anyone reads; sellers write only inside their own folder.
drop policy if exists "Shop media is public" on storage.objects;
create policy "Shop media is public" on storage.objects for select
  using (bucket_id = 'shop');
drop policy if exists "Sellers upload shop media" on storage.objects;
create policy "Sellers upload shop media" on storage.objects for insert
  with check (bucket_id = 'shop' and split_part(name, '/', 1) = auth.uid()::text);
drop policy if exists "Sellers manage shop media" on storage.objects;
create policy "Sellers manage shop media" on storage.objects for delete
  using (bucket_id = 'shop' and split_part(name, '/', 1) = auth.uid()::text);

-- Private bucket: the seller, plus any buyer whose order for that listing has
-- been DELIVERED (folder layout makes the listing id the 2nd path segment).
drop policy if exists "Deliverables readable by seller and buyers" on storage.objects;
create policy "Deliverables readable by seller and buyers" on storage.objects for select
  using (
    bucket_id = 'shop-files'
    and (
      split_part(name, '/', 1) = auth.uid()::text
      or exists (
        select 1 from public.shop_orders o
        where o.buyer_id = auth.uid()
          and o.status = 'delivered'
          and o.listing_id::text = split_part(name, '/', 2)
      )
    )
  );
drop policy if exists "Sellers upload deliverables" on storage.objects;
create policy "Sellers upload deliverables" on storage.objects for insert
  with check (bucket_id = 'shop-files' and split_part(name, '/', 1) = auth.uid()::text);
drop policy if exists "Sellers manage deliverables" on storage.objects;
create policy "Sellers manage deliverables" on storage.objects for delete
  using (bucket_id = 'shop-files' and split_part(name, '/', 1) = auth.uid()::text);

-- 5) Realtime — full rows so deletes carry keys (order status live-updates).
alter table public.shop_orders replica identity full;

-- ── v2: seller economics (idempotent for DBs created before it) ──────────────
-- Laybell fee snapshot per order (15%, lib/shop.ts SHOP_FEE_RATE).
alter table public.shop_orders add column if not exists fee_cents int not null default 0;

-- ── v3: trust & safety ────────────────────────────────────────────────────────
-- The marketplace settles payment off-platform, so protection concentrates on:
-- contract capacity (18+ sellers), documented consent (seller terms), abuse
-- throttles (buy-request flooding), reportability (scams/IP theft), and sane
-- content bounds. All idempotent.

-- 1) Sellers must be adults. Minors' contracts are voidable and marketplaces
--    that let minors sell carry real liability; buying stays open to all users
--    (the app itself is 13+ with parental consent).
drop policy if exists "Users can open their shop" on public.shops;
create policy "Users can open their shop" on public.shops for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and coalesce(p.age, 0) >= 18
    )
  );

-- 2) Documented seller-terms acceptance (set by the app at shop creation).
alter table public.shops add column if not exists accepted_terms_at timestamptz;

-- 3) Listing reports — feeds the same manual-moderation queue as post/user
--    reports. reason uses the app's shared report codes ('scam', 'ip', …).
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
-- No select policy: reports are read by moderators via the service role only.

-- 4) Buy-request throttle: 20 requests per buyer per 24h. Blocks harassment
--    floods and inventory-lockup attacks on exclusive listings.
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

-- 5) Content bounds the client already enforces, now guaranteed server-side
--    (deceptive mega-prices, unbounded text). $10,000 cap per digital listing.
alter table public.shop_listings drop constraint if exists shop_listings_title_len;
alter table public.shop_listings add constraint shop_listings_title_len
  check (char_length(title) <= 120);
alter table public.shop_listings drop constraint if exists shop_listings_desc_len;
alter table public.shop_listings add constraint shop_listings_desc_len
  check (description is null or char_length(description) <= 2000);
alter table public.shop_listings drop constraint if exists shop_listings_price_cap;
alter table public.shop_listings add constraint shop_listings_price_cap
  check (price_cents <= 1000000);
