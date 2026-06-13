-- Spotlight (formerly "Ads") — Supabase tables, RLS, and RPCs
-- The user-facing name is SPOTLIGHT; the DB objects keep their original ad_*
-- names, so an environment that already ran ads.sql needs nothing migrated —
-- re-running this file there is a harmless no-op. Run in the Supabase
-- Dashboard → SQL Editor (the anon key cannot create tables/policies/
-- functions). RUN THE UPDATED badges.sql FIRST — it carries the
-- ad_engagements daily counter the Patron badges read (the guard below fails
-- fast with a clear message if it's missing). Until this file is applied,
-- every spotlight query/rpc 404s, the client catches it, and the app behaves
-- exactly as before — the same graceful-degradation pattern
-- Badges/Stories/Archive use.
--
-- Model
-- ─────
-- A user PAYS first (simulated checkout for now — ad_payments records the
-- intent so a real provider can be swapped in later), which creates a campaign
-- in `pending` with no post. Attaching a post — an existing public one, or one
-- created fresh from the composer — activates it: starts_at/ends_at stamp the
-- paid duration (1 / 3 / 7 days). `weight` (1 / 2 / 3) sets how long the
-- launch boost lasts (the ramp window in lib/spotlight.ts).
--
-- Placement is CLIENT-SIDE and scored (see lib/spotlight.ts): a spotlighted
-- post is scored like a regular post times a decaying, never-recovering
-- multiplier. By default the top spotlight is anchored as the Home "All"
-- feed's 3RD post (only genuine trending performance lets it climb to #1);
-- weak engagement decays the multiplier exponentially until the post ranks
-- like an average post, floored just above the feed's average score — always
-- seen, just much less. At least 6 regular posts separate any two spotlights,
-- and spotlights never receive the seen-penalty. Expiry is passive: the feed
-- only serves rows with ends_at > now(), and the owner's Spotlight screen
-- lazily settles `active` rows whose ends_at passed to `ended` (no cron
-- needed).
--
-- Stats integrity: impressions/taps go through an append-only per-(viewer,
-- campaign, kind) ledger — each viewer counts AT MOST ONCE per campaign per
-- engagement kind, enforced server-side, so a looped RPC call cannot inflate
-- (or pollute a competitor's) numbers. impression_count therefore reads as
-- unique reach, not raw scroll-bys.

-- ─── dependency guard ─────────────────────────────────────────────────────────
-- The Patron badges count ad engagements through the badges daily-counter
-- pipeline; badges.sql owns that schema (single source of truth — this file
-- must NOT redefine the badge functions). Fail loudly instead of silently
-- shipping badges that never progress.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'user_activity_daily'
       and column_name = 'ad_engagements'
  ) then
    raise exception 'Run the UPDATED badges.sql before spotlight.sql (user_activity_daily.ad_engagements is missing).';
  end if;
end $$;

-- ─── ad_campaigns ─────────────────────────────────────────────────────────────
-- One row per purchased spotlight. post_id is null while `pending` (paid but
-- no post attached yet — the user can resume from the Spotlight screen, so an
-- app kill mid-flow never loses a purchase).
create table if not exists public.ad_campaigns (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  post_id          uuid references public.posts(id) on delete cascade,
  package_key      text not null check (package_key in ('1d', '3d', '7d')),
  duration_days    integer not null check (duration_days > 0),
  price_cents      integer not null check (price_cents >= 0),
  weight           integer not null default 1 check (weight between 1 and 10),
  status           text not null default 'pending'
                     check (status in ('pending', 'active', 'ended', 'canceled')),
  starts_at        timestamptz,
  ends_at          timestamptz,
  impression_count integer not null default 0,
  tap_count        integer not null default 0,
  created_at       timestamptz not null default now()
);

-- The feed's hot path: active campaigns that haven't expired.
create index if not exists ad_campaigns_live_idx
  on public.ad_campaigns (status, ends_at) where status = 'active';
create index if not exists ad_campaigns_user_idx
  on public.ad_campaigns (user_id, created_at desc);

alter table public.ad_campaigns enable row level security;

-- Everyone can read LIVE campaigns (the feed needs them to serve ads). The
-- promoted post itself still goes through the posts policies — a hidden
-- author's post embed comes back null and the client drops the ad.
drop policy if exists "Live ad campaigns are visible" on public.ad_campaigns;
create policy "Live ad campaigns are visible"
on public.ad_campaigns for select
using (status = 'active' and ends_at > now());

-- Owners see all their campaigns (the Ads screen lists every status).
drop policy if exists "Owners read own ad campaigns" on public.ad_campaigns;
create policy "Owners read own ad campaigns"
on public.ad_campaigns for select
using (auth.uid() = user_id);

-- Hidden accounts are invisible app-wide (account_hidden.sql) — their campaign
-- ROWS (existence, owner id, stats) must not leak either, not just the post
-- content. Restrictive, so it ANDs with both select policies above; the owner
-- still sees their own. Guarded: profiles.hidden only exists once
-- account_hidden.sql has been applied.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'profiles' and column_name = 'hidden'
  ) then
    drop policy if exists "Hidden authors' ad campaigns are invisible" on public.ad_campaigns;
    create policy "Hidden authors' ad campaigns are invisible"
      on public.ad_campaigns as restrictive for select
      using (
        user_id = auth.uid()
        or not exists (select 1 from public.profiles p where p.id = user_id and p.hidden)
      );
  end if;
end $$;

drop policy if exists "Users create own ad campaigns" on public.ad_campaigns;
create policy "Users create own ad campaigns"
on public.ad_campaigns for insert
with check (auth.uid() = user_id);

-- Owners manage their campaigns (attach a post, cancel, end early). The check
-- enforces that only the owner's OWN PUBLIC posts can ever be promoted — the
-- picker UI filters too, but the rule belongs where the money commits (a post
-- flipped to friends-only between pick and attach is rejected here).
drop policy if exists "Owners update own ad campaigns" on public.ad_campaigns;
create policy "Owners update own ad campaigns"
on public.ad_campaigns for update
using (auth.uid() = user_id)
with check (
  auth.uid() = user_id
  and (
    post_id is null
    or exists (
      select 1 from public.posts p
      where p.id = post_id
        and p.user_id = auth.uid()
        and p.is_public = true
    )
  )
);

-- ─── ad_payments ──────────────────────────────────────────────────────────────
-- Payment intents/receipts, one per purchase. provider is 'simulated' until a
-- real processor (Stripe / IAP) lands — then provider/provider_ref carry the
-- external charge id and this table becomes the reconciliation point. Campaign
-- creation and ALL payment mutation should move server-side (Edge Function
-- webhook) at that point.
create table if not exists public.ad_payments (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  campaign_id   uuid references public.ad_campaigns(id) on delete set null,
  amount_cents  integer not null check (amount_cents >= 0),
  currency      text not null default 'usd',
  provider      text not null default 'simulated',
  provider_ref  text,
  status        text not null default 'succeeded'
                  check (status in ('succeeded', 'refunded', 'failed')),
  created_at    timestamptz not null default now()
);

create index if not exists ad_payments_user_idx
  on public.ad_payments (user_id, created_at desc);

alter table public.ad_payments enable row level security;

drop policy if exists "Users read own ad payments" on public.ad_payments;
create policy "Users read own ad payments"
on public.ad_payments for select
using (auth.uid() = user_id);

drop policy if exists "Users insert own ad payments" on public.ad_payments;
create policy "Users insert own ad payments"
on public.ad_payments for insert
with check (auth.uid() = user_id);

-- The ONLY legitimate client write is marking a canceled pending campaign
-- refunded — status is pinned so a client can never rewrite a payment to
-- 'succeeded' (or anything else) once a real provider trusts this table.
drop policy if exists "Users update own ad payments" on public.ad_payments;
drop policy if exists "Users refund own ad payments" on public.ad_payments;
create policy "Users refund own ad payments"
on public.ad_payments for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id and status = 'refunded');

-- ─── ad_engagement_events (anti-fraud ledger) ─────────────────────────────────
-- One row per (campaign, viewer, kind) — the primary key IS the dedup. The
-- security-definer RPCs below are the only readers/writers (no client
-- policies), and a counter only increments when a ledger insert actually
-- landed, so direct-RPC loops cannot inflate stats. Same hardening pattern as
-- record_stream_rpc.sql.
create table if not exists public.ad_engagement_events (
  campaign_id  uuid not null references public.ad_campaigns(id) on delete cascade,
  viewer_id    uuid not null references auth.users(id) on delete cascade,
  kind         text not null check (kind in ('impression', 'like', 'comment', 'save', 'share')),
  created_at   timestamptz not null default now(),
  primary key (campaign_id, viewer_id, kind)
);

alter table public.ad_engagement_events enable row level security;

-- ─── record_ad_impression / record_ad_tap ─────────────────────────────────────
-- Security-definer counters so viewers (who can't update campaign rows) can
-- still bump the stats. Both no-op on the owner's own campaigns (watching your
-- own ad never inflates the numbers), on anything not currently live, and on
-- any (viewer, campaign, kind) already in the ledger.
drop function if exists public.record_ad_impression(uuid);
create or replace function public.record_ad_impression(p_campaign uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_owner uuid;
  v_ins   integer;
begin
  if v_uid is null then return; end if;

  select user_id into v_owner
    from public.ad_campaigns
   where id = p_campaign and status = 'active' and ends_at > now();
  if v_owner is null or v_owner = v_uid then return; end if;

  insert into public.ad_engagement_events (campaign_id, viewer_id, kind)
  values (p_campaign, v_uid, 'impression')
  on conflict do nothing;
  get diagnostics v_ins = row_count;
  if v_ins = 0 then return; end if;

  update public.ad_campaigns
     set impression_count = impression_count + 1
   where id = p_campaign;
end;
$$;

grant execute on function public.record_ad_impression(uuid) to authenticated;

drop function if exists public.record_ad_tap(uuid);
create or replace function public.record_ad_tap(p_campaign uuid, p_kind text default 'like')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_owner uuid;
  v_kind  text := case when p_kind in ('like', 'comment', 'save', 'share') then p_kind else 'like' end;
  v_ins   integer;
begin
  if v_uid is null then return; end if;

  select user_id into v_owner
    from public.ad_campaigns
   where id = p_campaign and status = 'active' and ends_at > now();
  if v_owner is null or v_owner = v_uid then return; end if;

  insert into public.ad_engagement_events (campaign_id, viewer_id, kind)
  values (p_campaign, v_uid, v_kind)
  on conflict do nothing;
  get diagnostics v_ins = row_count;
  if v_ins = 0 then return; end if;

  update public.ad_campaigns
     set tap_count = tap_count + 1
   where id = p_campaign;
end;
$$;

grant execute on function public.record_ad_tap(uuid, text) to authenticated;
