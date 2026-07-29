-- ════════════════════════════════════════════════════════════════════════════
-- LAYBELL — every pending migration, in dependency order. Generated 2026-07-28.
--
-- HOW TO RUN: paste a PART into the Supabase Dashboard → SQL Editor and Run.
-- Run the parts IN ORDER and let each finish before starting the next — later
-- files depend on objects earlier ones create.
--
-- Everything here is idempotent, so re-running a part you already applied is
-- safe. If you are unsure what has been applied, run all parts top to bottom.
--
-- Source of truth for the ordering: docs/LAUNCH_CHECKLIST.md §3.1
-- ════════════════════════════════════════════════════════════════════════════

-- ─── PART 3 of 3 ─────────────────────────────────────────────
-- Files in this part, in order:
--   1. ad_ecosystem.sql  (re-run — adds objective columns)
--   2. post_top_caption.sql  (re-run — v2)
--   3. shop_multi.sql
--   4. wallet_earnings.sql  (adds delivered_earnings() — fixes the capped balance)
--   5. scale_indexes_2.sql
--   6. content_filter.sql  (NEW — term blocklist)
--   7. shop_downloads.sql  (NEW — dispute evidence; AFTER shop.sql)
--   8. minor_safety.sql  (NEW — is_minor() + followers-only DMs; AFTER profile_fields.sql)
--   9. ledger.sql  (NEW — the payments ledger; no dependencies beyond auth.users)
--   10. social_auth_trigger.sql  (RUN LAST — rewrites the auth.users new-user trigger)

-- ══════════════════════════════════════════════════════════════════════════
-- ad_ecosystem.sql  ·  re-run — adds objective columns
-- ══════════════════════════════════════════════════════════════════════════
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


-- ══════════════════════════════════════════════════════════════════════════
-- post_top_caption.sql  ·  re-run — v2
-- ══════════════════════════════════════════════════════════════════════════
-- Video captions — TikTok-style text bubbles the creator places on a clip.
-- HORIZONTAL clips: top_caption lives in the black letterbox band above the
-- video (rotating to fullscreen hides it — the bar no longer exists there)
-- and bottom_caption in the band below. VERTICAL clips fill the screen, so
-- top_caption doubles as the free-placement screen caption (its y spans the
-- safe area between the back-button strip and the reel's bottom UI); a post
-- is one orientation or the other, so the column's meaning is unambiguous.
--
-- One jsonb column on posts so it rides along with select('*') everywhere
-- (same pattern as slides / story caption_style):
--   { "text":  "…\n…",       -- caption lines
--     "bg":    "#FFFFFF",    -- bubble color
--     "color": "#111111",    -- text color
--     "y":     0.35,         -- 0..1 position within the safe band zone
--     "scale": 1.0 }         -- pinch size multiplier
--
-- Written spread-conditionally by the video upload queue, so until this file
-- is applied the insert simply omits the column — a safe no-op.

alter table public.posts add column if not exists top_caption jsonb;

-- ── v2: bottom caption ────────────────────────────────────────────────────────
-- Same bubble, same jsonb shape, parked in the BOTTOM letterbox band (kept
-- clear of the reel's meta block / action rail / scrub bar by the app's zone
-- math). Re-run this whole file to apply — both statements are idempotent.
alter table public.posts add column if not exists bottom_caption jsonb;

-- ── v3: vertical captions (story-style) ───────────────────────────────────────
-- VERTICAL clips get the story sticker system instead of the single screen
-- caption: `captions` is a jsonb ARRAY of freely-placed caption objects
--   { text, x, y, scale, rotation, font, color, bg, size }
-- (same shape as stories.stickers). Rendered in the reel viewer AND the home
-- feed. Landscape clips keep using top_caption / bottom_caption.
alter table public.posts add column if not exists captions jsonb;


-- ══════════════════════════════════════════════════════════════════════════
-- shop_multi.sql
-- ══════════════════════════════════════════════════════════════════════════
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


-- ══════════════════════════════════════════════════════════════════════════
-- wallet_earnings.sql  ·  adds delivered_earnings() — fixes the capped balance
-- ══════════════════════════════════════════════════════════════════════════
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


-- ══════════════════════════════════════════════════════════════════════════
-- scale_indexes_2.sql
-- ══════════════════════════════════════════════════════════════════════════
-- ============================================================================
-- Scale hardening #2 — indexes for messaging, search, browse-sort, and the
-- monetization lookups. Companion to scale_indexes.sql (which already covered
-- the feed, follow-graph, and notifications).
--
-- ⚠️ REVIEW-ONLY / RUN IT YOURSELF. This file was prepared by an automated
--    scalability audit but has NOT been applied to your database. Read it, then
--    run it in the Supabase SQL editor when you're ready. Nothing here touches
--    app code or changes behavior.
--
-- 100% additive and safe: an index only makes queries faster (or sits unused).
-- `if not exists` = idempotent, so re-running is harmless.
--
-- These target gaps the audit confirmed in the CURRENT schema:
--   • messages: 1:1 DMs are wholly unindexed today — only (conversation_id,
--     created_at) exists, so every DM open, the home unread badge (runs on every
--     home focus AND every realtime message), and mark-as-read seq-scan the
--     whole table.
--   • posts.stream_count: the dominant music/explore browse sort has no index —
--     ~7 section loads each full-scan + top-N sort the whole audio corpus.
--   • text search: every profile/post/community/shop search uses leading-wildcard
--     ILIKE '%term%' with no trigram index → a seq scan per keystroke.
--   • ad_campaigns.post_id / shop_orders: unindexed filters behind the per-profile
--     Spotlight badge check and the wallet/shop counts.
--
-- HOW TO RUN
--   • Early stage / low traffic: paste the whole file into the Supabase SQL
--     editor and run — each statement is near-instant on small tables.
--   • Large / live table under write load: run each statement individually as
--     `create index concurrently ...` so writes are never blocked. CONCURRENTLY
--     cannot run inside a transaction — run one at a time, not in BEGIN/COMMIT.
--     (pg_trgm's CREATE EXTENSION should run first, on its own.)
--
-- AUDIT FIRST (optional, read-only) — see what already exists so you can trim any
-- redundant line before running:
--   select tablename, indexname, indexdef
--   from pg_indexes
--   where schemaname = 'public'
--     and tablename in ('messages','posts','profiles','communities',
--                       'shop_listings','ad_campaigns','shop_orders')
--   order by tablename, indexname;
-- ============================================================================


-- ── messages: 1:1 DM access (the biggest risk/reward item) ──────────────────
-- Powers the unread badge's `receiver_id = me and read = false`, the thread
-- fetch's `or(sender.eq/receiver.eq)`, and mark-as-read. The partial unread
-- index stays tiny (only unread rows).
create index if not exists messages_receiver_unread_idx
  on public.messages (receiver_id) where read = false;
create index if not exists messages_sender_receiver_idx
  on public.messages (sender_id, receiver_id, created_at);
create index if not exists messages_receiver_sender_idx
  on public.messages (receiver_id, sender_id, created_at);


-- ── posts.stream_count: the music/explore browse sort ───────────────────────
-- Partial index matches the exact filter those queries use, so it stays small
-- and serves `order by stream_count desc` without a full-corpus scan.
create index if not exists posts_audio_streams_idx
  on public.posts (stream_count desc)
  where is_public and type = 'audio' and archived_at is null;


-- ── trigram search: stop seq-scanning on every keystroke ────────────────────
-- pg_trgm lets a GIN index serve leading-wildcard ILIKE '%term%'. One extension
-- + one index per searched text column.
create extension if not exists pg_trgm;
create index if not exists profiles_username_trgm
  on public.profiles using gin (username gin_trgm_ops);
create index if not exists profiles_display_trgm
  on public.profiles using gin (display_name gin_trgm_ops);
create index if not exists posts_caption_trgm
  on public.posts using gin (caption gin_trgm_ops);
create index if not exists communities_name_trgm
  on public.communities using gin (name gin_trgm_ops);
create index if not exists shop_listings_title_trgm
  on public.shop_listings using gin (title gin_trgm_ops);
-- Optional — only if you search listing descriptions too:
-- create index if not exists shop_listings_desc_trgm
--   on public.shop_listings using gin (description gin_trgm_ops);


-- ── monetization lookups ────────────────────────────────────────────────────
-- ad_campaigns.post_id: the per-profile Spotlight-badge `in(post_id, gridIds)`
-- check and the pre-delete `eq(post_id)` check.
create index if not exists ad_campaigns_post_idx
  on public.ad_campaigns (post_id);

-- shop_orders: the seller/listing count filters behind the wallet + shop UI.
create index if not exists shop_orders_seller_status_idx
  on public.shop_orders (seller_id, status);
create index if not exists shop_orders_listing_status_idx
  on public.shop_orders (listing_id, status);


-- ══════════════════════════════════════════════════════════════════════════
-- content_filter.sql  ·  NEW — term blocklist
-- ══════════════════════════════════════════════════════════════════════════
-- Content filter — the curated term blocklist behind lib/contentFilter.ts.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
--
-- WHY: Apple Guideline 1.2 and Play's UGC policy expect a UGC app to have "a
-- method for filtering objectionable material from being posted." Laybell had
-- reporting, blocking and a moderation console — all REACTIVE. This is the
-- proactive half.
--
-- Mirrors blocked_link_domains from link_safety.sql: the client merges this over a
-- small built-in seed, so moderation policy can change without an app release.
-- Until this runs, the seed alone applies and nothing breaks.
--
-- Terms are matched on WORD BOUNDARIES against normalized text (case-folded,
-- de-accented, leetspeak-collapsed, repeat-collapsed). So a row for "badword"
-- catches "B4DW0RD" and "b-a-d-w-o-r-d" but NOT "badwordsmith" — add stems
-- deliberately rather than relying on substring behaviour.

create table if not exists public.blocked_terms (
  term       text primary key,
  -- 'block'  → the write is refused outright.
  -- 'review' → the write goes through but is flagged for the moderation queue.
  severity   text not null default 'block' check (severity in ('block', 'review')),
  -- Free-text note for whoever reads this table in six months.
  reason     text,
  created_at timestamptz not null default now()
);

alter table public.blocked_terms enable row level security;

-- Signed-in clients READ the list so they can cache and enforce it. Note this
-- makes the list readable by anyone with an account — which is inherent to
-- client-side filtering and is why the filter is a speed bump, not a boundary.
-- Nothing sensitive belongs in `reason`.
drop policy if exists "Anyone signed in can read blocked terms" on public.blocked_terms;
create policy "Anyone signed in can read blocked terms"
  on public.blocked_terms for select
  to authenticated
  using (true);

-- No insert/update/delete policy: the list is maintained from the Dashboard or by
-- the service role only. A client must never be able to edit the filter that
-- constrains it.

-- ── Seeding ──────────────────────────────────────────────────────────────────
-- Left EMPTY on purpose. The built-in seed in lib/contentFilter.ts covers slurs
-- and sexual-solicitation patterns; this table is where the owner's own policy
-- goes, and what belongs in it is a moderation decision, not a migration.
--
-- Add terms like:
--   insert into public.blocked_terms (term, severity, reason) values
--     ('examplebadword', 'block',  'slur — reported repeatedly'),
--     ('borderlineword', 'review', 'often abusive in context, needs a human')
--   on conflict (term) do update
--     set severity = excluded.severity, reason = excluded.reason;
--
-- Review what is actually getting flagged before expanding this. An over-broad
-- filter trains users to route around it and buries the moderation queue in
-- false positives, which is worse than a narrow one.


-- ══════════════════════════════════════════════════════════════════════════
-- shop_downloads.sql  ·  NEW — dispute evidence; AFTER shop.sql
-- ══════════════════════════════════════════════════════════════════════════
-- Shop download log — evidence for payment disputes.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
-- Requires shop.sql (shop_orders) to have run first.
--
-- WHY THIS EXISTS: a beat is delivered instantly, is non-returnable, and is
-- infinitely copyable — the worst possible shape for a card dispute. When Laybell
-- moves to real payments with Stripe destination charges, the PLATFORM balance is
-- debited on a chargeback, and recovery depends on reversing the seller's transfer
-- while they still have a balance. The single piece of evidence that wins these
-- disputes is Stripe's `access_activity_log` field: server logs proving the buyer
-- accessed or downloaded the product after paying, with IP addresses and
-- timestamps. Without this table that evidence does not exist and every dispute is
-- conceded by default.
--
-- Append-only by design: rows are inserted by the buyer at download time and can
-- never be updated or deleted by any client. Nothing here is shown in the UI — it
-- exists purely to be exported when a dispute arrives.

create table if not exists public.shop_downloads (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references public.shop_orders(id) on delete cascade,
  buyer_id     uuid not null references auth.users(id) on delete cascade,
  -- Which file was handed over, so a multi-file or re-listed order stays unambiguous.
  file_path    text,
  -- Captured client-side and therefore ADVISORY, not authoritative: a determined
  -- buyer can lie about their own user agent. The timestamp, the order linkage and
  -- the authenticated buyer_id are the parts that carry weight in a dispute.
  user_agent   text,
  platform     text,
  downloaded_at timestamptz not null default now()
);

create index if not exists shop_downloads_order_idx on public.shop_downloads (order_id);
create index if not exists shop_downloads_buyer_idx on public.shop_downloads (buyer_id, downloaded_at desc);

alter table public.shop_downloads enable row level security;

-- A buyer may record ONLY their own download, and only against an order that is
-- actually theirs and actually delivered. This is what makes a row meaningful as
-- evidence: it cannot be fabricated for someone else's order.
drop policy if exists "Buyers log their own downloads" on public.shop_downloads;
create policy "Buyers log their own downloads"
  on public.shop_downloads for insert
  with check (
    buyer_id = auth.uid()
    and exists (
      select 1 from public.shop_orders o
      where o.id = public.shop_downloads.order_id
        and o.buyer_id = auth.uid() and o.status = 'delivered'
    )
  );

-- Buyer sees their own history; the seller sees downloads of their own orders
-- (they need it to answer a "never received it" claim). Deliberately no update or
-- delete policy anywhere — the log is append-only for everyone, including the
-- people it is about.
drop policy if exists "Download log is visible to the parties" on public.shop_downloads;
create policy "Download log is visible to the parties"
  on public.shop_downloads for select
  using (
    buyer_id = auth.uid()
    or exists (
      select 1 from public.shop_orders o
      where o.id = public.shop_downloads.order_id and o.seller_id = auth.uid()
    )
  );

-- Export for a dispute (run from the dashboard, service role):
--   select d.downloaded_at, d.buyer_id, d.file_path, d.user_agent, d.platform,
--          o.price_cents, o.created_at as ordered_at
--   from public.shop_downloads d
--   join public.shop_orders o on o.id = d.order_id
--   where o.id = '<order uuid>'
--   order by d.downloaded_at;


-- ══════════════════════════════════════════════════════════════════════════
-- minor_safety.sql  ·  NEW — is_minor() + followers-only DMs; AFTER profile_fields.sql
-- ══════════════════════════════════════════════════════════════════════════
-- Minor safety — server-enforced teen defaults.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
-- Requires profile_fields.sql (profiles.dob / profiles.age) to have run.
--
-- The client already applies these rules (lib/minors.ts), but a client-side check
-- is a UX affordance, not a control — a modified client ignores it. Direct
-- messages to a minor are the one place where that distinction actually matters,
-- so the rule is enforced in the database.
--
-- Everything here is ADDITIVE and uses RESTRICTIVE policies, which AND with the
-- existing permissive policies rather than replacing them (same approach as
-- account_hidden.sql). No existing policy is dropped or rewritten.

-- ── is_minor(uuid) ───────────────────────────────────────────────────────────
-- dob is the source of truth; the denormalized `age` column is the fallback for
-- rows written before dob existed.
--
-- Note the default: an account with NO age information is treated as NOT a minor
-- here. That is deliberate and matches lib/minors.ts — the restriction applies to
-- people we affirmatively know are under 18, so an ageless legacy row does not
-- silently lose the ability to receive messages. Age is required at onboarding, so
-- this only affects pre-migration accounts.
create or replace function public.is_minor(p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select case
       when p.dob is not null then (p.dob > (current_date - interval '18 years'))
       when p.age is not null then (p.age < 18)
       else false
     end
     from public.profiles p where p.id = p_id),
    false);
$$;

grant execute on function public.is_minor(uuid) to authenticated;

-- ── Followers-only DMs for minors ────────────────────────────────────────────
-- An adult stranger cannot open a DM with a minor. The minor must have followed
-- them first, which makes the contact something the minor chose rather than
-- something that arrived unbidden. Minor-to-anyone and adult-to-adult messaging
-- are untouched.
--
-- `follows` here means "the receiver follows the sender" — following is the
-- affirmative act that establishes consent to be contacted.
do $$
begin
  if to_regclass('public.messages') is null then
    raise notice 'public.messages not found — skipping the DM policy';
    return;
  end if;

  execute $p$
    drop policy if exists "Minors receive DMs only from people they follow" on public.messages;
  $p$;

  execute $p$
    create policy "Minors receive DMs only from people they follow"
      on public.messages as restrictive for insert
      with check (
        public.messages.sender_id = public.messages.receiver_id
        or not public.is_minor(public.messages.receiver_id)
        or exists (
          select 1 from public.follows f
          where f.follower_id = public.messages.receiver_id and f.following_id = public.messages.sender_id
        )
      );
  $p$;
end $$;

-- Group chats reuse public.messages via conversation_id, where receiver_id is
-- null. A null receiver_id makes `is_minor(receiver_id)` null and the whole check
-- null, which Postgres treats as a policy FAILURE — that would break group chat
-- entirely. Guard it explicitly.
do $$
begin
  if to_regclass('public.messages') is null then return; end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'messages' and column_name = 'conversation_id'
  ) then
    execute $p$
      drop policy if exists "Minors receive DMs only from people they follow" on public.messages;
    $p$;
    execute $p$
      create policy "Minors receive DMs only from people they follow"
        on public.messages as restrictive for insert
        with check (
          public.messages.receiver_id is null                       -- group message; not a 1:1 DM
          or public.messages.sender_id = public.messages.receiver_id
          or not public.is_minor(public.messages.receiver_id)
          or exists (
            select 1 from public.follows f
            where f.follower_id = public.messages.receiver_id and f.following_id = public.messages.sender_id
          )
        );
    $p$;
  end if;
end $$;

-- To verify after running:
--   select public.is_minor('<a minor uuid>');   -- expect true
--   select public.is_minor('<an adult uuid>');  -- expect false
--
-- To roll back:
--   drop policy if exists "Minors receive DMs only from people they follow" on public.messages;
--   drop function if exists public.is_minor(uuid);


-- ══════════════════════════════════════════════════════════════════════════
-- ledger.sql  ·  NEW — the payments ledger; no dependencies beyond auth.users
-- ══════════════════════════════════════════════════════════════════════════
-- ════════════════════════════════════════════════════════════════════════════
-- LAYBELL LEDGER — the single source of truth for money on the platform.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
--
-- WHY THIS EXISTS
-- Laybell has five money surfaces (Premium, tips, the beat shop, Spotlight, the
-- Ad Manager) and will have three processors (Apple IAP, Google Play Billing,
-- Stripe). Wiring five features to three processors directly is fifteen
-- integrations, and Apple's external-purchase commission is actively being
-- re-litigated — so the rails WILL change.
--
-- Instead every feature moves value against this ledger, and each processor is
-- merely a FUNDING SOURCE into it. When Apple's commission lands at whatever
-- number, you change a funding source, not five features.
--
--     Apple IAP ─┐
--     Play Bill. ─┼──▶ [ credits ] ──▶ purchases / tips ──▶ [ earnings ] ──▶ Stripe
--     Stripe web ─┘                                                          payout
--
-- TWO ACCOUNT KINDS, AND THE DISTINCTION IS LOAD-BEARING
--   'credits'  — bought with real money, SPEND-ONLY, never redeemable for cash.
--                Non-cashable is what keeps credits out of stored-value / prepaid
--                access territory and away from state money-transmitter licensing.
--                If a credit can ever become cash in the buyer's hands, that
--                analysis changes completely. Do not add a credits→bank path.
--   'earnings' — what a creator has actually earned and CAN withdraw, via Stripe
--                Connect, after a hold. This is the only cashable balance.
--   'platform' — Laybell's own counterparty account. Fees land here.
--
-- INVARIANTS THIS FILE ENFORCES (not by convention — by constraint):
--   1. Entries are APPEND-ONLY. Update and delete raise an exception, for
--      everyone including the service role. A ledger you can edit is not a ledger.
--   2. Every transaction BALANCES TO ZERO. Money is moved, never created.
--   3. Idempotent posting. A retried Stripe webhook or re-validated Apple receipt
--      cannot double-credit — (source, external_id) is unique.
--   4. Balances are maintained by trigger and never written directly, so
--      account.balance_cents cannot drift from sum(entries).
--   5. No client can write. Every value movement happens server-side.
--
-- Amounts are integer CENTS in bigint. Never floats — binary floating point
-- cannot represent 0.10 and money bugs from it are unfixable after the fact.
-- ════════════════════════════════════════════════════════════════════════════


-- ─── 1) Accounts ────────────────────────────────────────────────────────────
create table if not exists public.ledger_accounts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete restrict,
  kind          text not null check (kind in ('credits', 'earnings', 'platform')),
  currency      text not null default 'USD',
  -- Maintained ONLY by the trigger below. Never write this column directly.
  balance_cents bigint not null default 0,
  created_at    timestamptz not null default now()
);

-- One account per (user, kind, currency). The platform account has a null user,
-- so a partial unique index covers it separately.
create unique index if not exists ledger_accounts_user_kind_idx
  on public.ledger_accounts (user_id, kind, currency) where user_id is not null;
create unique index if not exists ledger_accounts_platform_idx
  on public.ledger_accounts (kind, currency) where user_id is null;

-- on delete restrict above is deliberate: deleting a user with a non-zero balance
-- must fail loudly rather than silently destroying a financial record. Account
-- deletion has to settle the balance first.


-- ─── 2) Transactions ────────────────────────────────────────────────────────
-- A transaction groups the entries that must be atomic and must balance.
create table if not exists public.ledger_transactions (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in (
                'funding',      -- real money entered (IAP / Play / Stripe)
                'purchase',     -- buyer spends credits on a listing
                'tip',          -- viewer tips a host
                'promotion',    -- Spotlight / ad spend
                'subscription', -- Premium
                'refund',
                'chargeback',
                'payout',       -- earnings leave to a bank via Connect
                'adjustment'    -- manual correction; always explain it
              )),
  -- Where the money came from, when it came from outside. 'internal' means value
  -- moved between existing Laybell accounts and no processor was involved.
  source      text not null default 'internal'
              check (source in ('internal', 'apple_iap', 'google_play', 'stripe', 'manual')),
  -- The processor's own id for this event: a Stripe event id, an Apple original
  -- transaction id, a Play purchase token. THIS is what makes posting idempotent.
  external_id text,
  memo        text,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- The idempotency guarantee. A webhook that fires three times posts once.
create unique index if not exists ledger_tx_external_idx
  on public.ledger_transactions (source, external_id) where external_id is not null;
create index if not exists ledger_tx_created_idx on public.ledger_transactions (created_at desc);


-- ─── 3) Entries ─────────────────────────────────────────────────────────────
create table if not exists public.ledger_entries (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.ledger_transactions(id) on delete restrict,
  account_id     uuid not null references public.ledger_accounts(id) on delete restrict,
  -- Signed: positive credits the account, negative debits it.
  amount_cents   bigint not null check (amount_cents <> 0),
  -- When this money becomes withdrawable. A shop sale sits on a hold so a
  -- chargeback lands before the seller has cashed out and vanished — see
  -- docs/LAUNCH_CHECKLIST.md §6.5. Funding and tips are available immediately.
  available_at   timestamptz not null default now(),
  created_at     timestamptz not null default now()
);

create index if not exists ledger_entries_account_idx
  on public.ledger_entries (account_id, created_at desc);
create index if not exists ledger_entries_tx_idx on public.ledger_entries (transaction_id);
-- Drives the available-balance sum.
create index if not exists ledger_entries_available_idx
  on public.ledger_entries (account_id, available_at);


-- ─── 4) Append-only enforcement ─────────────────────────────────────────────
-- Invariant 1. Corrections are posted as NEW compensating transactions, never by
-- editing history. This fires for the service role too — there is deliberately no
-- way to quietly rewrite a balance.
create or replace function public.ledger_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'ledger_entries is append-only (attempted %). Post a compensating transaction instead.', tg_op;
end $$;

drop trigger if exists ledger_entries_no_update on public.ledger_entries;
create trigger ledger_entries_no_update
  before update or delete on public.ledger_entries
  for each row execute function public.ledger_immutable();


-- ─── 5) Balance maintenance ─────────────────────────────────────────────────
-- Invariant 4. Because entries are append-only, a running total maintained here
-- can never drift from sum(entries) — there is no edit path that could desync it.
create or replace function public.ledger_apply_entry()
returns trigger language plpgsql as $$
begin
  update public.ledger_accounts
     set balance_cents = balance_cents + new.amount_cents
   where id = new.account_id;
  return new;
end $$;

drop trigger if exists ledger_entries_apply on public.ledger_entries;
create trigger ledger_entries_apply
  after insert on public.ledger_entries
  for each row execute function public.ledger_apply_entry();


-- ─── 6) Account helper ──────────────────────────────────────────────────────
create or replace function public.ledger_account(p_user uuid, p_kind text, p_currency text default 'USD')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  if p_kind = 'platform' then
    select id into v_id from public.ledger_accounts
      where user_id is null and kind = 'platform' and currency = p_currency;
    if v_id is null then
      insert into public.ledger_accounts (user_id, kind, currency)
        values (null, 'platform', p_currency) returning id into v_id;
    end if;
    return v_id;
  end if;

  if p_user is null then
    raise exception 'a % account needs a user', p_kind;
  end if;
  select id into v_id from public.ledger_accounts
    where user_id = p_user and kind = p_kind and currency = p_currency;
  if v_id is null then
    insert into public.ledger_accounts (user_id, kind, currency)
      values (p_user, p_kind, p_currency) returning id into v_id;
  end if;
  return v_id;
end $$;


-- ─── 7) Posting ─────────────────────────────────────────────────────────────
-- The ONLY way value moves. Takes a jsonb array of legs:
--
--   [{"user": "<uuid>|null", "kind": "credits|earnings|platform",
--     "amount_cents": -500, "available_at": "2026-08-11T00:00:00Z"}, ...]
--
-- Enforces invariants 2, 3 and 5. Returns the transaction id; on a repeated
-- (source, external_id) it returns the EXISTING id and posts nothing, so callers
-- can retry blindly — which is exactly what webhook delivery requires.
create or replace function public.ledger_post(
  p_kind        text,
  p_legs        jsonb,
  p_source      text default 'internal',
  p_external_id text default null,
  p_memo        text default null,
  p_metadata    jsonb default '{}'::jsonb,
  p_currency    text default 'USD'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tx       uuid;
  v_sum      bigint := 0;
  v_leg      jsonb;
  v_account  uuid;
  v_amount   bigint;
  v_akind    text;
  v_touched  uuid[] := '{}';
  v_bad      record;
begin
  if jsonb_typeof(p_legs) <> 'array' or jsonb_array_length(p_legs) < 2 then
    raise exception 'a transaction needs at least two legs';
  end if;

  -- Invariant 3: idempotency. Checked BEFORE any work so a retry is cheap.
  if p_external_id is not null then
    select id into v_tx from public.ledger_transactions
      where source = p_source and external_id = p_external_id;
    if v_tx is not null then
      return v_tx;   -- already posted; do nothing
    end if;
  end if;

  -- Invariant 2: the legs must sum to zero. Money is moved, never created.
  for v_leg in select * from jsonb_array_elements(p_legs) loop
    v_sum := v_sum + (v_leg->>'amount_cents')::bigint;
  end loop;
  if v_sum <> 0 then
    raise exception 'transaction does not balance: legs sum to % cents, expected 0', v_sum;
  end if;

  begin
    insert into public.ledger_transactions (kind, source, external_id, memo, metadata)
      values (p_kind, p_source, p_external_id, p_memo, coalesce(p_metadata, '{}'::jsonb))
      returning id into v_tx;
  exception when unique_violation then
    -- Two concurrent deliveries of the same webhook both passed the check above.
    -- The unique index is the real guarantee; the loser simply returns the id the
    -- winner created. Idempotency must survive races, not just retries.
    select id into v_tx from public.ledger_transactions
      where source = p_source and external_id = p_external_id;
    return v_tx;
  end;

  for v_leg in select * from jsonb_array_elements(p_legs) loop
    v_akind  := v_leg->>'kind';
    v_amount := (v_leg->>'amount_cents')::bigint;
    v_account := public.ledger_account(
      nullif(v_leg->>'user', '')::uuid, v_akind, p_currency);

    insert into public.ledger_entries (transaction_id, account_id, amount_cents, available_at)
      values (
        v_tx, v_account, v_amount,
        coalesce((v_leg->>'available_at')::timestamptz, now())
      );

    if v_akind <> 'platform' then
      v_touched := v_touched || v_account;
    end if;
  end loop;

  -- A user account must never end up negative — that would mean Laybell paid out,
  -- or let someone spend, money they never had. The platform account MAY go
  -- negative: absorbing a chargeback before recovering it from a seller is a real
  -- state, and hiding it would be worse than showing it.
  --
  -- Checked AFTER every leg is posted, not inside the loop: a single transaction
  -- may legitimately debit and then credit the same account, and an intermediate
  -- negative is not an error. Only the settled state matters.
  select a.id, a.balance_cents, a.kind, a.user_id into v_bad
    from public.ledger_accounts a
   where a.id = any(v_touched) and a.balance_cents < 0
   limit 1;
  if found then
    raise exception 'insufficient funds: % account for user % would settle at % cents',
      v_bad.kind, v_bad.user_id, v_bad.balance_cents;
  end if;

  return v_tx;
end $$;

-- Invariant 5: nothing client-side may post. Every caller is an edge function
-- using the service role (which bypasses these grants), or the dashboard.
revoke all on function public.ledger_post(text, jsonb, text, text, text, jsonb, text) from public;
revoke all on function public.ledger_post(text, jsonb, text, text, text, jsonb, text) from authenticated;
revoke all on function public.ledger_account(uuid, text, text) from public;
revoke all on function public.ledger_account(uuid, text, text) from authenticated;


-- ─── 8) Reading a balance ───────────────────────────────────────────────────
-- `total` is everything the account holds; `available` excludes money still on a
-- hold. Available is computed rather than stored because it changes with the
-- clock, not with any write — a stored copy would need a sweeper and could go
-- stale. The partial index above keeps the sum cheap.
create or replace function public.my_ledger_balance(p_currency text default 'USD')
returns table (kind text, total_cents bigint, available_cents bigint)
language sql
stable
security definer
set search_path = public
as $$
  select a.kind,
         a.balance_cents as total_cents,
         coalesce((
           select sum(e.amount_cents) from public.ledger_entries e
            where e.account_id = a.id and e.available_at <= now()
         ), 0) as available_cents
    from public.ledger_accounts a
   where a.user_id = auth.uid() and a.currency = p_currency;
$$;

grant execute on function public.my_ledger_balance(text) to authenticated;


-- ─── 9) RLS ─────────────────────────────────────────────────────────────────
-- Read-only for the owner; no write policy exists for anyone. The service role
-- bypasses RLS, so edge functions still post normally.
alter table public.ledger_accounts     enable row level security;
alter table public.ledger_transactions enable row level security;
alter table public.ledger_entries      enable row level security;

drop policy if exists "Users read their own ledger accounts" on public.ledger_accounts;
create policy "Users read their own ledger accounts"
  on public.ledger_accounts for select using (user_id = auth.uid());

-- NOTE: columns of the policy's own table are FULLY QUALIFIED inside these
-- subqueries. An unqualified `id` or `account_id` is ambiguous once the subquery
-- joins tables that have a column of the same name, and Postgres rejects the
-- whole statement with "column reference ... is ambiguous". Qualifying costs
-- nothing and removes the entire class of error.
drop policy if exists "Users read their own ledger entries" on public.ledger_entries;
create policy "Users read their own ledger entries"
  on public.ledger_entries for select using (
    exists (select 1 from public.ledger_accounts a
             where a.id = public.ledger_entries.account_id and a.user_id = auth.uid())
  );

drop policy if exists "Users read their own transactions" on public.ledger_transactions;
create policy "Users read their own transactions"
  on public.ledger_transactions for select using (
    exists (select 1 from public.ledger_entries e
             join public.ledger_accounts a on a.id = e.account_id
            where e.transaction_id = public.ledger_transactions.id
              and a.user_id = auth.uid())
  );


-- ─── 10) Statement view ─────────────────────────────────────────────────────
-- What the user sees in the wallet: their own movements, newest first.
-- security_invoker: evaluate the underlying tables' RLS as the CALLER, not as the
-- view owner. Without it a Postgres view runs with the owner's privileges, which
-- would mean the view's own auth.uid() filter is the only thing standing between
-- one user and everyone's entries. Defence in depth on a money table.
create or replace view public.my_ledger_statement with (security_invoker = true) as
  select e.id,
         e.created_at,
         e.amount_cents,
         e.available_at,
         a.kind        as account_kind,
         t.kind        as transaction_kind,
         t.source,
         t.memo,
         t.metadata
    from public.ledger_entries e
    join public.ledger_accounts a on a.id = e.account_id
    join public.ledger_transactions t on t.id = e.transaction_id
   where a.user_id = auth.uid()
   order by e.created_at desc;

grant select on public.my_ledger_statement to authenticated;


-- ─── 11) Reconciliation ─────────────────────────────────────────────────────
-- Invariant 4 should make drift impossible. Verify it anyway — a ledger nobody
-- audits is a ledger nobody can trust. Run from the dashboard periodically; it
-- returns rows ONLY when something is wrong.
create or replace function public.ledger_verify()
returns table (account_id uuid, stored_cents bigint, computed_cents bigint)
language sql
stable
security definer
set search_path = public
as $$
  select a.id, a.balance_cents,
         coalesce((select sum(e.amount_cents) from public.ledger_entries e
                    where e.account_id = a.id), 0)
    from public.ledger_accounts a
   where a.balance_cents <> coalesce(
           (select sum(e.amount_cents) from public.ledger_entries e
             where e.account_id = a.id), 0);
$$;

-- Postgres grants EXECUTE on a new function to PUBLIC by default. Left as-is this
-- SECURITY DEFINER function would let any signed-in user enumerate every account
-- id and balance on the platform. Owner/dashboard only.
revoke all on function public.ledger_verify() from public;
revoke all on function public.ledger_verify() from authenticated;

-- Global solvency: every transaction balanced, so the sum of ALL entries must be
-- exactly zero. A non-zero result means money was created or destroyed.
--   select coalesce(sum(amount_cents), 0) from public.ledger_entries;  -- expect 0
--   select * from public.ledger_verify();                              -- expect 0 rows


-- ─── Worked examples (for the edge functions to follow) ─────────────────────
--
-- Buyer funds $10 of credits through Apple IAP. Real money entered, so the
-- platform account is the counterparty:
--   select public.ledger_post('funding',
--     jsonb_build_array(
--       jsonb_build_object('user', '<buyer>', 'kind', 'credits',  'amount_cents',  1000),
--       jsonb_build_object('user', null,      'kind', 'platform', 'amount_cents', -1000)),
--     'apple_iap', '<original_transaction_id>', 'Credits top-up');
--
-- Buyer spends $10 on a beat; Laybell keeps 15%; the seller's $8.50 is held 14
-- days so a chargeback lands before they can cash out:
--   select public.ledger_post('purchase',
--     jsonb_build_array(
--       jsonb_build_object('user', '<buyer>',  'kind', 'credits',  'amount_cents', -1000),
--       jsonb_build_object('user', '<seller>', 'kind', 'earnings', 'amount_cents',   850,
--                          'available_at', (now() + interval '14 days')),
--       jsonb_build_object('user', null,       'kind', 'platform', 'amount_cents',   150)),
--     'internal', 'order:<order uuid>', 'Beat sale');
--
-- A $6 tip to a standard-tier host (35% fee):
--   select public.ledger_post('tip',
--     jsonb_build_array(
--       jsonb_build_object('user', '<viewer>', 'kind', 'credits',  'amount_cents', -600),
--       jsonb_build_object('user', '<host>',   'kind', 'earnings', 'amount_cents',  390),
--       jsonb_build_object('user', null,       'kind', 'platform', 'amount_cents',  210)),
--     'internal', 'tip:<donation uuid>', 'Live tip');
--
-- Payout of $8.50 to the seller's bank via Stripe Connect:
--   select public.ledger_post('payout',
--     jsonb_build_array(
--       jsonb_build_object('user', '<seller>', 'kind', 'earnings', 'amount_cents', -850),
--       jsonb_build_object('user', null,       'kind', 'platform', 'amount_cents',  850)),
--     'stripe', '<stripe payout id>', 'Bank transfer');
--
-- Rollback:
--   drop view if exists public.my_ledger_statement;
--   drop function if exists public.ledger_verify, public.my_ledger_balance(text),
--                            public.ledger_post(text, jsonb, text, text, text, jsonb, text),
--                            public.ledger_account(uuid, text, text), public.ledger_apply_entry,
--                            public.ledger_immutable;
--   drop table if exists public.ledger_entries, public.ledger_transactions, public.ledger_accounts;


-- ══════════════════════════════════════════════════════════════════════════
-- social_auth_trigger.sql  ·  RUN LAST — rewrites the auth.users new-user trigger
-- ══════════════════════════════════════════════════════════════════════════
-- Fix "Database error saving new user" on Apple/Google sign-ins.
--
-- The auth.users trigger builds the profiles row from signup metadata
-- (username / display_name) that EMAIL signups always carry. Social sign-ins
-- carry none of it (Apple Hide-My-Email carries barely anything), so the
-- profile insert failed and rolled back the whole account creation — GoTrue
-- surfaces that as "Database error saving new user".
--
-- This tolerant replacement:
--   • keeps the email flow byte-identical (metadata still wins when present),
--   • derives a username for social users (email local part → sanitized →
--     padded to the app's 5-char minimum → random-suffixed on collision),
--   • and NEVER blocks the signup: if the profile insert still fails, the
--     account is created without a row and the app repairs it on first login
--     (lib/socialAuth.ts ensureProfileForSession).
--
-- Run in the Supabase SQL editor. No app rebuild needed.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  base text;
  uname text;
  dname text;
  n int := 0;
begin
  -- Display name: explicit metadata → provider full name → email local part.
  dname := coalesce(
    nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
    nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
    nullif(trim(new.raw_user_meta_data->>'name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Artist'
  );

  -- Username: explicit metadata → sanitized email local part.
  base := lower(coalesce(
    nullif(trim(new.raw_user_meta_data->>'username'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'artist'
  ));
  base := regexp_replace(base, '[^a-z0-9_]', '', 'g');
  if length(base) < 5 then
    base := rpad(base || 'artist', 5, '0');
  end if;
  base := left(base, 24);

  uname := base;
  while exists (select 1 from public.profiles where username = uname) and n < 20 loop
    n := n + 1;
    uname := left(base, 24) || (1000 + floor(random() * 9000))::int;
  end loop;

  begin
    insert into public.profiles (id, username, display_name, onboarded)
    values (new.id, uname, left(dname, 40), false)
    on conflict (id) do nothing;
  exception when others then
    -- NEVER block account creation over the profile row — the app rebuilds a
    -- missing row on first login.
    raise warning 'handle_new_user: profile insert failed for %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;

-- Point the conventional trigger at the (re)placed function — idempotent.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Diagnostics: every user-defined trigger on auth.users. If social signup
-- STILL errors after this, the original trigger has a non-conventional name —
-- paste this output back and it can be targeted precisely.
select t.tgname as trigger_name, p.proname as function_name
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_proc p on p.oid = t.tgfoid
where n.nspname = 'auth' and c.relname = 'users' and not t.tgisinternal;


