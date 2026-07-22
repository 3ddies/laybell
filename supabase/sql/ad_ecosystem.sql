-- Ad Ecosystem — dedicated-creative ads across Feed, Reels and Audio + a self-
-- serve Ad Manager. Supabase tables, RLS, and RPC.
--
-- This is a SEPARATE product from Spotlight. Spotlight (spotlight.sql) promotes
-- a user's EXISTING post into the Home feed. Ads here serve DEDICATED creatives
-- the advertiser uploads (image/video/slideshow → feed, video → reels, audio
-- clip → audio breaks) with a headline, body, CTA button and destination URL,
-- a budget, optional lightweight targeting, and analytics. The two coexist in
-- the same ad_campaigns table, kept apart by a new `kind` column AND by
-- post_id (ads always have post_id = null; Spotlight's fetchFeedSpotlights
-- requires an embedded post, so it never picks up ad rows).
--
-- Run order — in the Supabase Dashboard → SQL Editor (the anon key cannot
-- create tables/policies/functions):
--   1) badges.sql   (user_activity_daily.ad_engagements — Patron badges)
--   2) spotlight.sql (creates public.ad_campaigns + ad_payments this file ALTERs)
--   3) ad_ecosystem.sql (THIS FILE)
-- The guard below fails fast with a clear message if (1)/(2) are missing.
--
-- Until this file is applied, every ad query/rpc 404s, the client catches it,
-- and the app behaves exactly as before — the same graceful-degradation
-- pattern Spotlight/Badges/Stories use. Re-running this file is a harmless
-- no-op (everything is `if not exists` / `drop ... then create`).
--
-- Billing is SIMULATED: a campaign carries a budget; each genuinely-new
-- impression accrues simulated CPM spend (spent_millicents, so the pacing bar
-- moves even at low volume), and the campaign auto-ends when spend reaches the
-- budget. ad_payments (from spotlight.sql) records the intent so a real
-- provider (Stripe / IAP) can be swapped in later — at which point campaign
-- creation and ALL spend/payment mutation should move server-side (Edge
-- Function webhook), exactly as the ad_payments comment in spotlight.sql notes.
--
-- Stats integrity: impressions are deduped per (viewer, campaign, placement,
-- hour) by a partial unique index, and spend only accrues when a ledger insert
-- actually lands — so a looped RPC call cannot inflate reach or drain a budget.

-- ─── dependency guard ─────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'ad_campaigns'
  ) then
    raise exception 'Run spotlight.sql before ad_ecosystem.sql (public.ad_campaigns is missing).';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'user_activity_daily'
       and column_name = 'ad_engagements'
  ) then
    raise exception 'Run the UPDATED badges.sql before ad_ecosystem.sql (user_activity_daily.ad_engagements is missing).';
  end if;
end $$;

-- ─── extend ad_campaigns (additive — legacy Spotlight rows untouched) ──────────
-- All new columns are nullable or defaulted; existing Spotlight rows simply
-- leave them at their defaults (kind = 'spotlight'). Ads set kind = 'ad'.
alter table public.ad_campaigns add column if not exists kind            text not null default 'spotlight';
alter table public.ad_campaigns add column if not exists objective       text;          -- 'awareness' | 'traffic' | 'engagement'
alter table public.ad_campaigns add column if not exists placements      text[];        -- subset of {'feed','reels','audio','tv'}
alter table public.ad_campaigns add column if not exists budget_cents_total integer;
alter table public.ad_campaigns add column if not exists budget_cents_daily integer;
alter table public.ad_campaigns add column if not exists spent_cents     integer not null default 0;
-- Spend accrues in millicents so a single low-CPM impression still moves the
-- bar; spent_cents is derived (spent_millicents / 1000) for display/budget.
alter table public.ad_campaigns add column if not exists spent_millicents bigint not null default 0;
alter table public.ad_campaigns add column if not exists bid_cpm_cents   integer;
alter table public.ad_campaigns add column if not exists click_count     integer not null default 0;
alter table public.ad_campaigns add column if not exists advertiser_name text;
alter table public.ad_campaigns add column if not exists is_business     boolean not null default false;
-- Display avatar shown on the ad: a business uploads its own logo/profile
-- picture; a regular-user campaign snapshots the creator's own profile avatar at
-- creation. Null = fall back to the advertiser-name initial.
alter table public.ad_campaigns add column if not exists advertiser_avatar_url text;
alter table public.ad_campaigns add column if not exists policy_accepted_at timestamptz;
-- Lightweight, all-optional targeting (null = no constraint = everyone).
alter table public.ad_campaigns add column if not exists target_age_min  integer;
alter table public.ad_campaigns add column if not exists target_age_max  integer;
alter table public.ad_campaigns add column if not exists target_gender   text;
alter table public.ad_campaigns add column if not exists target_genres   text[];
alter table public.ad_campaigns add column if not exists target_lat      double precision;
alter table public.ad_campaigns add column if not exists target_lng      double precision;
alter table public.ad_campaigns add column if not exists target_radius_km double precision;

-- ─── objective destinations (added 2026-07-23) ─────────────────────────────────
-- Each objective sends a tap somewhere specific (no CHECK — free-form text, so a
-- future objective never needs a constraint migration):
--   'awareness'  → a Laybell PROFILE (own, someone else's, or several: a tap
--                  opens a chooser). Stored as target_profile_ids.
--   'traffic'    → an external WEBSITE via the creative's cta_url (unchanged).
--   'engagement' → the advertiser's SHOP; target_shop_listing_id is the listing
--                  they picked to feature (its cover is shown while building).
alter table public.ad_campaigns add column if not exists target_profile_ids uuid[];
alter table public.ad_campaigns add column if not exists target_shop_listing_id uuid;

-- Relax the Spotlight-only constraints so ad rows can omit them. These ONLY
-- widen the rules (… is null or <old check>) — every existing Spotlight insert
-- still passes. Drop-then-add keeps the whole file idempotent across re-runs.
-- NOTE: the list MUST stay a superset of spotlight.sql's package keys
-- ('12h','1d','3d','7d'); omitting '12h' here made a re-run reject existing
-- 12-hour Spotlight rows (ad_campaigns_package_key_check violation).
alter table public.ad_campaigns alter column package_key   drop not null;
alter table public.ad_campaigns drop constraint if exists ad_campaigns_package_key_check;
alter table public.ad_campaigns add  constraint ad_campaigns_package_key_check
  check (package_key is null or package_key in ('12h', '1d', '3d', '7d'));

alter table public.ad_campaigns alter column duration_days drop not null;
alter table public.ad_campaigns drop constraint if exists ad_campaigns_duration_days_check;
alter table public.ad_campaigns add  constraint ad_campaigns_duration_days_check
  check (duration_days is null or duration_days > 0);

alter table public.ad_campaigns alter column price_cents   drop not null;
alter table public.ad_campaigns drop constraint if exists ad_campaigns_price_cents_check;
alter table public.ad_campaigns add  constraint ad_campaigns_price_cents_check
  check (price_cents is null or price_cents >= 0);

-- 'paused' = advertiser-paused or daily-cap reached (resumable). 'ended' =
-- budget spent / schedule over / ended early (terminal).
alter table public.ad_campaigns drop constraint if exists ad_campaigns_status_check;
alter table public.ad_campaigns add  constraint ad_campaigns_status_check
  check (status in ('pending', 'active', 'ended', 'canceled', 'paused'));

alter table public.ad_campaigns drop constraint if exists ad_campaigns_kind_check;
alter table public.ad_campaigns add  constraint ad_campaigns_kind_check
  check (kind in ('spotlight', 'ad'));

-- The ad serving hot path: live ad campaigns.
create index if not exists ad_campaigns_serving_idx
  on public.ad_campaigns (kind, status, ends_at) where kind = 'ad' and status = 'active';

-- NOTE: the existing "Live ad campaigns are visible" SELECT policy
-- (status='active' and ends_at>now()) already exposes live AD rows to everyone,
-- which is what serving needs. Schedule (starts_at) and budget gating happen in
-- lib/ads.ts (isInSchedule / isInBudget) and in record_ad_event below, so the
-- shipped Spotlight policy is left untouched.

-- Defense in depth: a NOT-YET-STARTED ad campaign would otherwise be a visible
-- 'active' row, leaking its budget/bid/targeting columns to any signed-in user
-- before it serves. This restrictive policy ANDs with the visible policy to hide
-- future-start AD rows from non-owners (Spotlight rows and already-started ads
-- are exempt; owners always see their own).
drop policy if exists "Scheduled ads hidden until start" on public.ad_campaigns;
create policy "Scheduled ads hidden until start"
  on public.ad_campaigns as restrictive for select
  using (
    user_id = auth.uid()
    or kind <> 'ad'
    or starts_at is null
    or starts_at <= now()
  );

-- ─── ad_creatives ─────────────────────────────────────────────────────────────
-- The uploaded ad units. One creative per chosen placement on a campaign.
create table if not exists public.ad_creatives (
  id               uuid primary key default gen_random_uuid(),
  campaign_id      uuid not null references public.ad_campaigns(id) on delete cascade,
  placement        text not null check (placement in ('feed', 'reels', 'audio', 'tv')),
  media_type       text not null check (media_type in ('image', 'video', 'slideshow', 'audio')),
  media_url        text,
  slides           jsonb,          -- same Slide[] shape as posts.slides (feed slideshows)
  thumbnail_url    text,
  cover_url        text,
  aspect_ratio     text,
  duration_seconds integer,
  headline         text,
  body             text,
  cta_label        text,
  cta_url          text,
  -- Laybell TV + music ads: 'unskippable' (plays fully, ≤15s) or 'skip15'
  -- (skippable after 15s, >15s). Null = placement default (reels 5s). No CHECK
  -- constraint on purpose — validated client-side, kept free so a value change
  -- never needs a constraint migration.
  skip_mode        text,
  created_at       timestamptz not null default now()
);

-- Additive migration for installs created before skip_mode existed.
alter table public.ad_creatives add column if not exists skip_mode text;

create index if not exists ad_creatives_campaign_idx on public.ad_creatives (campaign_id);
create index if not exists ad_creatives_placement_idx on public.ad_creatives (placement);

alter table public.ad_creatives enable row level security;

-- Everyone can read creatives of a LIVE ad campaign (serving). starts_at is
-- enforced here too so a scheduled-future campaign's creatives don't serve early.
drop policy if exists "Live ad creatives are visible" on public.ad_creatives;
create policy "Live ad creatives are visible"
on public.ad_creatives for select
using (
  exists (
    select 1 from public.ad_campaigns c
     where c.id = campaign_id
       and c.kind = 'ad'
       and c.status = 'active'
       and (c.starts_at is null or c.starts_at <= now())
       and (c.ends_at is null or c.ends_at > now())
  )
);

-- Owners read/manage their own creatives (the Ad Manager).
drop policy if exists "Owners read own ad creatives" on public.ad_creatives;
create policy "Owners read own ad creatives"
on public.ad_creatives for select
using (exists (select 1 from public.ad_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));

drop policy if exists "Owners write own ad creatives" on public.ad_creatives;
create policy "Owners write own ad creatives"
on public.ad_creatives for insert
with check (exists (select 1 from public.ad_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));

drop policy if exists "Owners update own ad creatives" on public.ad_creatives;
create policy "Owners update own ad creatives"
on public.ad_creatives for update
using (exists (select 1 from public.ad_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));

drop policy if exists "Owners delete own ad creatives" on public.ad_creatives;
create policy "Owners delete own ad creatives"
on public.ad_creatives for delete
using (exists (select 1 from public.ad_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));

-- Hidden advertisers' creatives must not leak (mirrors the spotlight.sql
-- restrictive policy). Guarded: profiles.hidden only exists after
-- account_hidden.sql. Restrictive → ANDs with the select policies above.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'profiles' and column_name = 'hidden'
  ) then
    drop policy if exists "Hidden authors' ad creatives are invisible" on public.ad_creatives;
    create policy "Hidden authors' ad creatives are invisible"
      on public.ad_creatives as restrictive for select
      using (
        exists (
          select 1 from public.ad_campaigns c
           where c.id = campaign_id
             and (
               c.user_id = auth.uid()
               or not exists (select 1 from public.profiles p where p.id = c.user_id and p.hidden)
             )
        )
      );
  end if;
end $$;

-- ─── ad_events (append-only ledger + analytics source) ────────────────────────
-- Unlike spotlight's ad_engagement_events (PK = once-ever-per-kind), ads need
-- per-impression accrual and the same campaign can appear in multiple
-- placements — so this is a richer event log. The security-definer RPC below is
-- the only writer (no client insert policy); owners can SELECT their own events
-- for analytics.
create table if not exists public.ad_events (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references public.ad_campaigns(id) on delete cascade,
  creative_id  uuid references public.ad_creatives(id) on delete set null,
  viewer_id    uuid references auth.users(id) on delete set null,
  placement    text not null check (placement in ('feed', 'reels', 'audio', 'tv')),
  kind         text not null check (kind in ('impression', 'click', 'skip', 'complete')),
  hour_bucket  bigint not null,
  created_at   timestamptz not null default now()
);

create index if not exists ad_events_campaign_idx on public.ad_events (campaign_id, created_at desc);
-- Runaway-spend guard: an impression counts AT MOST once per (viewer, campaign,
-- placement, hour). Clicks/skips/completes are deduped client-side per session.
create unique index if not exists ad_events_impression_dedup
  on public.ad_events (campaign_id, viewer_id, placement, hour_bucket) where kind = 'impression';

-- ─── Migration: allow the 'tv' placement on ALREADY-APPLIED installs ──────────
-- `create table if not exists` above never rewrites an existing table's inline
-- CHECK, so a DB created before Laybell TV ads still rejects placement='tv'.
-- Drop whatever check constrains each placement column and re-add one that
-- includes 'tv'. Idempotent — safe to re-run (fresh installs just rename the
-- inline check to the named one).
do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.ad_creatives'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%placement%'
  loop
    execute format('alter table public.ad_creatives drop constraint %I', r.conname);
  end loop;
  alter table public.ad_creatives
    add constraint ad_creatives_placement_chk check (placement in ('feed', 'reels', 'audio', 'tv'));

  for r in
    select conname from pg_constraint
    where conrelid = 'public.ad_events'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%placement%'
  loop
    execute format('alter table public.ad_events drop constraint %I', r.conname);
  end loop;
  alter table public.ad_events
    add constraint ad_events_placement_chk check (placement in ('feed', 'reels', 'audio', 'tv'));
end $$;

alter table public.ad_events enable row level security;

drop policy if exists "Owners read own ad events" on public.ad_events;
create policy "Owners read own ad events"
on public.ad_events for select
using (exists (select 1 from public.ad_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));

-- ─── record_ad_event ──────────────────────────────────────────────────────────
-- Security-definer so viewers (who can't write campaign rows) can bump stats and
-- accrue simulated spend. No-ops on the owner's own ads, on anything not
-- currently live/in-schedule, and on a duplicate impression for this hour.
drop function if exists public.record_ad_event(uuid, uuid, text, text);
create or replace function public.record_ad_event(
  p_campaign  uuid,
  p_creative  uuid,
  p_placement text,
  p_kind      text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_owner  uuid;
  v_cpm    integer;
  v_budget integer;
  v_spent_milli bigint;
  v_kind   text := case when p_kind in ('impression', 'click', 'skip', 'complete') then p_kind else 'impression' end;
  v_place  text := case when p_placement in ('feed', 'reels', 'audio', 'tv') then p_placement else 'feed' end;
  v_hour   bigint := floor(extract(epoch from now()) * 1000 / 3600000)::bigint;
  v_ins    integer;
begin
  if v_uid is null then return; end if;

  select user_id, coalesce(bid_cpm_cents, 0), budget_cents_total
    into v_owner, v_cpm, v_budget
    from public.ad_campaigns
   where id = p_campaign
     and kind = 'ad'
     and status = 'active'
     and (starts_at is null or starts_at <= now())
     and (ends_at  is null or ends_at  > now());
  if v_owner is null or v_owner = v_uid then return; end if;

  -- Music + Laybell TV are PREMIUM unskippable placements: they cost the
  -- advertiser 20% more per view (that surcharge is Laybell's), so their
  -- impressions accrue spend 20% faster than feed/reels.
  if v_place in ('audio', 'tv') then
    v_cpm := round(v_cpm * 1.2);
  end if;

  -- Volume bonus: bigger budgets stretch further (more views per dollar), a
  -- tiered effective-CPM discount capped at +25%. KEEP IN SYNC with
  -- lib/ads.adVolumeBonus. Applied AFTER the premium so both compose.
  if    v_budget >= 100000 then v_cpm := round(v_cpm / 1.25);
  elsif v_budget >=  50000 then v_cpm := round(v_cpm / 1.20);
  elsif v_budget >=  25000 then v_cpm := round(v_cpm / 1.15);
  elsif v_budget >=  10000 then v_cpm := round(v_cpm / 1.10);
  elsif v_budget >=   5000 then v_cpm := round(v_cpm / 1.05);
  end if;
  if v_cpm < 1 then v_cpm := 1; end if; -- never zero (would never end)

  if v_kind = 'impression' then
    insert into public.ad_events (campaign_id, creative_id, viewer_id, placement, kind, hour_bucket)
    values (p_campaign, p_creative, v_uid, v_place, 'impression', v_hour)
    on conflict do nothing;
    get diagnostics v_ins = row_count;
    if v_ins = 0 then return; end if;  -- already counted this hour

    -- spent_millicents in the SET is the OLD value; the new total is +v_cpm.
    -- The status='active' guard stops a concurrent racer from accruing spend/
    -- impressions onto a campaign another call just settled to 'ended'.
    update public.ad_campaigns
       set impression_count = impression_count + 1,
           spent_millicents = spent_millicents + v_cpm,
           spent_cents      = ((spent_millicents + v_cpm) / 1000)::int
     where id = p_campaign and status = 'active'
     returning spent_millicents into v_spent_milli;
    if v_spent_milli is null then return; end if;

    -- Budget spent → settle to 'ended'.
    if v_budget is not null and (v_spent_milli / 1000) >= v_budget then
      update public.ad_campaigns set status = 'ended' where id = p_campaign and status = 'active';
    end if;
  else
    insert into public.ad_events (campaign_id, creative_id, viewer_id, placement, kind, hour_bucket)
    values (p_campaign, p_creative, v_uid, v_place, v_kind, v_hour);
    if v_kind = 'click' then
      update public.ad_campaigns set click_count = click_count + 1 where id = p_campaign;
    end if;
  end if;
end;
$$;

grant execute on function public.record_ad_event(uuid, uuid, text, text) to authenticated;

-- ─── ad_reports (mirror post_reports.sql) ─────────────────────────────────────
-- Backs "Report this ad" on every placement. Until applied, the insert no-ops.
create table if not exists public.ad_reports (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.ad_campaigns(id) on delete cascade,
  creative_id uuid references public.ad_creatives(id) on delete set null,
  reporter_id uuid references auth.users(id) on delete set null,
  reason      text not null default 'other',
  created_at  timestamptz not null default now()
);

create index if not exists ad_reports_campaign_idx on public.ad_reports (campaign_id);

alter table public.ad_reports enable row level security;

drop policy if exists "Users can file ad reports" on public.ad_reports;
create policy "Users can file ad reports"
on public.ad_reports for insert
with check (auth.uid() = reporter_id);

drop policy if exists "Users can view own ad reports" on public.ad_reports;
create policy "Users can view own ad reports"
on public.ad_reports for select
using (auth.uid() = reporter_id);

-- ─── Harden the legacy Spotlight RPCs against ad rows ─────────────────────────
-- record_ad_impression / record_ad_tap (spotlight.sql) select an active campaign
-- with NO `kind` filter. Now that ads live in the same table, a caller could bump
-- an AD's counters through the Spotlight ledger — bypassing record_ad_event's
-- per-hour dedup and CPM spend. Re-create them here (after `kind` exists) so they
-- only ever touch spotlight rows. Spotlight serving (lib/spotlight.ts) is
-- unchanged — it only passes spotlight campaign ids.
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
   where id = p_campaign and kind = 'spotlight' and status = 'active' and ends_at > now();
  if v_owner is null or v_owner = v_uid then return; end if;

  insert into public.ad_engagement_events (campaign_id, viewer_id, kind)
  values (p_campaign, v_uid, 'impression')
  on conflict do nothing;
  get diagnostics v_ins = row_count;
  if v_ins = 0 then return; end if;

  update public.ad_campaigns set impression_count = impression_count + 1 where id = p_campaign;
end;
$$;
grant execute on function public.record_ad_impression(uuid) to authenticated;

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
   where id = p_campaign and kind = 'spotlight' and status = 'active' and ends_at > now();
  if v_owner is null or v_owner = v_uid then return; end if;

  insert into public.ad_engagement_events (campaign_id, viewer_id, kind)
  values (p_campaign, v_uid, v_kind)
  on conflict do nothing;
  get diagnostics v_ins = row_count;
  if v_ins = 0 then return; end if;

  update public.ad_campaigns set tap_count = tap_count + 1 where id = p_campaign;
end;
$$;
grant execute on function public.record_ad_tap(uuid, text) to authenticated;
