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

-- ─── PART 1 of 3 ─────────────────────────────────────────────
-- Files in this part, in order:
--   1. badges.sql  (re-run — updated 2026-07-09)
--   2. spotlight.sql  (AFTER badges)
--   3. tagged_mentions.sql  (re-run — updated 2026-07-09)
--   4. music_order.sql
--   5. admin_console.sql  (strict order: before admin_console_rpcs)

-- ══════════════════════════════════════════════════════════════════════════
-- badges.sql  ·  re-run — updated 2026-07-09
-- ══════════════════════════════════════════════════════════════════════════
-- Profile Badges / Gamification — Supabase tables, RLS, and RPCs
-- Run in the Supabase Dashboard → SQL Editor (the anon key cannot create tables/
-- policies/functions). Until this is applied, every badge rpc/select 404s, the
-- client catches it, and the app behaves exactly as before (no emblem shown) —
-- so the app keeps working either way (same graceful-degradation pattern the
-- Stories/Archive features use).
--
-- Model
-- ─────
-- A user accrues lightweight daily activity counters in `user_activity_daily`
-- (one row per UTC day — the row's mere existence also means "logged in that
-- day"). The client's evaluator (lib/badges.ts) reads a 92-day window via
-- get_badge_state() (sized for the 90-day permanent login diamond + grace),
-- derives streaks/criteria, and reconciles which badges the
-- user currently holds into `user_badges`. Holding a badge can be revoked when
-- its streak/criteria lapse (R), unless the badge is permanent (Per). The user's
-- overall status is a point rollup cached on profiles.badge_tier (the emblem
-- shown next to their name app-wide).
--
-- Day boundary
-- ────────────
-- "Today" and "N days in a row" are reckoned in UTC, computed server-side here
-- (never from the device clock) so they can't be spoofed or drift across
-- timezones — the day rolls over at 00:00 UTC. Daily counters "reset" implicitly:
-- a new UTC day simply has a fresh zero-counter row, and streaks are derived from
-- which days have rows, so there is nothing to actively reset (no cron needed).

-- ─── user_activity_daily ──────────────────────────────────────────────────────
-- One row per (user, UTC day). Counters are incremented atomically through
-- record_badge_activity(); the row existing at all marks the user as active that
-- day (powers login streaks).
create table if not exists public.user_activity_daily (
  user_id        uuid not null references auth.users(id) on delete cascade,
  day            date not null,
  likes          integer not null default 0,
  comments       integer not null default 0,
  music_seconds  integer not null default 0,
  posts_created  integer not null default 0,
  ad_engagements integer not null default 0,
  updated_at     timestamptz not null default now(),
  primary key (user_id, day)
);

-- Installs that predate the Spotlight feature gain the counter on re-run (this
-- file is the single source of truth for the badge schema + functions —
-- spotlight.sql depends on it but never redefines any of this).
alter table public.user_activity_daily
  add column if not exists ad_engagements integer not null default 0;

create index if not exists user_activity_daily_user_day_idx
  on public.user_activity_daily (user_id, day desc);

alter table public.user_activity_daily enable row level security;

-- A user can read only their own activity (the evaluator goes through the
-- security-definer get_badge_state() RPC, but own-read is useful for debugging).
drop policy if exists "Users read own activity" on public.user_activity_daily;
create policy "Users read own activity"
on public.user_activity_daily for select
using (auth.uid() = user_id);

-- Writes flow through the security-definer record_badge_activity() RPC, but keep
-- own-write policies so a direct client write (if ever needed) stays scoped.
drop policy if exists "Users insert own activity" on public.user_activity_daily;
create policy "Users insert own activity"
on public.user_activity_daily for insert
with check (auth.uid() = user_id);

drop policy if exists "Users update own activity" on public.user_activity_daily;
create policy "Users update own activity"
on public.user_activity_daily for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- ─── user_badges ──────────────────────────────────────────────────────────────
-- The badges a user currently holds. `category`/`tier` are denormalised from the
-- badge_key (e.g. 'login_gold' → category 'login', tier 'gold') so reads/queries
-- don't have to parse the key. `is_permanent` badges are never revoked once held.
create table if not exists public.user_badges (
  user_id       uuid not null references auth.users(id) on delete cascade,
  badge_key     text not null,
  category      text not null,
  tier          text not null,
  is_permanent  boolean not null default false,
  earned_at     timestamptz not null default now(),
  primary key (user_id, badge_key)
);

create index if not exists user_badges_user_idx on public.user_badges (user_id);

alter table public.user_badges enable row level security;

-- Any signed-in user can read badges (so a future "see their badges" surface
-- works); the emblem itself reads the cached profiles.badge_tier.
drop policy if exists "Badges are readable" on public.user_badges;
create policy "Badges are readable"
on public.user_badges for select
to authenticated
using (true);

-- A user reconciles only their own badges (the evaluator writes these directly).
drop policy if exists "Users insert own badges" on public.user_badges;
create policy "Users insert own badges"
on public.user_badges for insert
with check (auth.uid() = user_id);

drop policy if exists "Users update own badges" on public.user_badges;
create policy "Users update own badges"
on public.user_badges for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users delete own badges" on public.user_badges;
create policy "Users delete own badges"
on public.user_badges for delete
using (auth.uid() = user_id);

-- ─── profiles: badge display + customization columns ─────────────────────────
-- badge_tier already exists (the cached emblem tier). Add the hide/show toggle
-- and the chosen-customization columns. These inherit the profiles SELECT policy,
-- so visitors see your emblem + chosen theme/ring.
alter table public.profiles
  add column if not exists badge_show       boolean not null default true,
  add column if not exists profile_theme    text,
  add column if not exists story_ring_style text,
  -- Lifetime count of times the user has shared/invited others to the app.
  -- Drives the App-sharing (Advocate) badges: bronze 1, silver 8, gold 15.
  -- A cumulative total (not per-day), so it lives on profiles, not the daily
  -- table, and is read directly by fetchBadgeState.
  add column if not exists app_shares       integer not null default 0;

-- ─── record_badge_activity ────────────────────────────────────────────────────
-- Atomically upsert today's (UTC) row and increment one counter. Called by the
-- client at each activity site. p_count = 0 is the "login touch": it just ensures
-- today's row exists (marking the user active today) without changing a counter.
-- Unknown categories add nothing (safe no-op) but still touch the row.
create or replace function public.record_badge_activity(p_category text, p_count integer default 1)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_day date := (now() at time zone 'utc')::date;
begin
  if v_uid is null then return; end if;

  insert into public.user_activity_daily (user_id, day)
  values (v_uid, v_day)
  on conflict (user_id, day) do nothing;

  if p_count = 0 then
    update public.user_activity_daily
       set updated_at = now()
     where user_id = v_uid and day = v_day;
    return;
  end if;

  update public.user_activity_daily
     set likes          = likes          + (case when p_category = 'likes'          then p_count else 0 end),
         comments       = comments       + (case when p_category = 'comments'       then p_count else 0 end),
         music_seconds  = music_seconds  + (case when p_category = 'music_seconds'  then p_count else 0 end),
         posts_created  = posts_created  + (case when p_category = 'posts_created'  then p_count else 0 end),
         ad_engagements = ad_engagements + (case when p_category = 'ad_engagements' then p_count else 0 end),
         updated_at     = now()
   where user_id = v_uid and day = v_day;
end;
$$;

grant execute on function public.record_badge_activity(text, integer) to authenticated;

-- ─── record_app_share ─────────────────────────────────────────────────────────
-- Atomically bump the caller's lifetime app-share counter by one. Called each
-- time the user completes a share of the app (the profile-QR "Share" sheet /
-- invite). Cumulative and permanent-ish (only ever increments), driving the
-- App-sharing badges. Single-statement UPDATE, so concurrent shares can't lose
-- an increment.
create or replace function public.record_app_share()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return; end if;
  update public.profiles
     set app_shares = coalesce(app_shares, 0) + 1
   where id = v_uid;
end;
$$;

grant execute on function public.record_app_share() to authenticated;

-- ─── get_badge_state ──────────────────────────────────────────────────────────
-- One round trip for the evaluator: the current UTC date, the caller's last
-- 92 daily rows (newest first — enough for the 90-day permanent login streak
-- plus the grace day), and their live public-post count using the SAME
-- filter the profile grid uses (is_public AND not archived) so the posts badge
-- always agrees with what the user sees. Falls back to is_public-only if the
-- archived_at column isn't present in this environment.
create or replace function public.get_badge_state()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_today  date := (now() at time zone 'utc')::date;
  v_daily  jsonb := '[]'::jsonb;
  v_posts  integer := 0;
begin
  if v_uid is null then
    return jsonb_build_object('today', v_today, 'daily', v_daily, 'public_posts', 0);
  end if;

  select coalesce(jsonb_agg(to_jsonb(d) order by d.day desc), '[]'::jsonb)
    into v_daily
    from (
      select day, likes, comments, music_seconds, posts_created, ad_engagements
        from public.user_activity_daily
       where user_id = v_uid
         and day >= v_today - 92
    ) d;

  begin
    select count(*) into v_posts
      from public.posts
     where user_id = v_uid and is_public = true and archived_at is null;
  exception when undefined_column then
    select count(*) into v_posts
      from public.posts
     where user_id = v_uid and is_public = true;
  end;

  return jsonb_build_object('today', v_today, 'daily', v_daily, 'public_posts', v_posts);
end;
$$;

grant execute on function public.get_badge_state() to authenticated;

-- ─── optional: old-activity cleanup ───────────────────────────────────────────
-- Not required for correctness (the evaluator only ever looks back ~92 days).
-- Housekeeping only — run manually, or schedule with pg_cron:
--   select cron.schedule('purge-badge-activity', '30 3 * * *', $$select public.purge_old_badge_activity()$$);
create or replace function public.purge_old_badge_activity()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.user_activity_daily
   where day < (now() at time zone 'utc')::date - 120;
$$;


-- ══════════════════════════════════════════════════════════════════════════
-- spotlight.sql  ·  AFTER badges
-- ══════════════════════════════════════════════════════════════════════════
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
  package_key      text not null check (package_key in ('12h', '1d', '3d', '7d')),
  -- numeric: the 12-hour package stores 0.5 days.
  duration_days    numeric(4, 2) not null check (duration_days > 0),
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

-- ── v2 packages (idempotent migration for DBs created before it) ─────────────
-- 12 Hours $5.99 (4h guaranteed placement) · 1 Day $10.99 (8h) ·
-- 3 Days $24.99 (24h) · 7 Days $49.99 (36h). The placement window per weight
-- lives in lib/spotlight.ts rampHoursFor (weights 1–4).
alter table public.ad_campaigns drop constraint if exists ad_campaigns_package_key_check;
alter table public.ad_campaigns add constraint ad_campaigns_package_key_check
  check (package_key in ('12h', '1d', '3d', '7d'));
alter table public.ad_campaigns alter column duration_days type numeric(4, 2);


-- ══════════════════════════════════════════════════════════════════════════
-- tagged_mentions.sql  ·  re-run — updated 2026-07-09
-- ══════════════════════════════════════════════════════════════════════════
-- "Tagged" feature: @mentions + song-usage notifications.
--
-- Run this in the Supabase dashboard SQL editor. Safe to re-run.

-- 1) Mentions: a row per (@mentioned user) in a post caption or a comment body.
--    Written by the author (actor); read by the mentioned user.
create table if not exists public.mentions (
  id                uuid primary key default gen_random_uuid(),
  mentioned_user_id uuid not null references auth.users(id) on delete cascade,
  actor_id          uuid not null references auth.users(id) on delete cascade,
  post_id           uuid references public.posts(id) on delete cascade,
  comment_id        uuid references public.comments(id) on delete cascade,
  created_at        timestamptz not null default now()
);

alter table public.mentions enable row level security;

-- You can read mentions OF you (for the Tagged screen) or ones you wrote.
drop policy if exists "mentions_select" on public.mentions;
create policy "mentions_select" on public.mentions
  for select using (auth.uid() = mentioned_user_id or auth.uid() = actor_id);

-- You can only create mentions as yourself (the author).
drop policy if exists "mentions_insert" on public.mentions;
create policy "mentions_insert" on public.mentions
  for insert with check (auth.uid() = actor_id);

create index if not exists mentions_mentioned_idx on public.mentions(mentioned_user_id, created_at desc);

-- 2) Allow the new notification types. The notifications.type CHECK constraint
--    (if one exists) only permitted like/comment/follow/message; recreate it with
--    the new mention + song-usage types so those inserts don't fail. 'friend' is
--    the mutual-follow notification (a follow-back that makes you friends — see
--    contexts/FollowContext); it must be allowed too or following back errors.
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('like','comment','follow','friend','message','mention','song_used','song_story','tag'));

-- 3) Let the original artist SEE any post/story that used their song (for the
--    Tagged screen) — even a followers-only one from someone they don't follow.
--    These are additive (RLS select policies are OR'd) and only ever match rows
--    where the querying user IS the song's artist.
drop policy if exists "posts_song_artist_select" on public.posts;
create policy "posts_song_artist_select" on public.posts
  for select using (auth.uid() = song_artist_id);

drop policy if exists "stories_song_artist_select" on public.stories;
create policy "stories_song_artist_select" on public.stories
  for select using (auth.uid() = song_artist_id);

create index if not exists posts_song_artist_idx on public.posts(song_artist_id);
create index if not exists stories_song_artist_idx on public.stories(song_artist_id);


-- ══════════════════════════════════════════════════════════════════════════
-- music_order.sql
-- ══════════════════════════════════════════════════════════════════════════
-- Premium perk: custom ordering of a user's profile Music tab.
--
-- `music_order` is a jsonb ARRAY of the user's own audio-post ids, in the exact
-- order they want them to appear in their Music tab. At render time the listed
-- ids come first (in this order); any tracks NOT in the list fall back to the
-- default order (newest-first) at the end, and deleted/missing ids are skipped.
-- Null/absent = default order (no customization).
--
-- Editing is gated to Premium in the app (lib/entitlements isPremium); the column
-- itself inherits the existing profiles RLS — the owner updates their own row,
-- everyone can read it (so the custom order shows to profile visitors too).
alter table public.profiles
  add column if not exists music_order jsonb;


-- ══════════════════════════════════════════════════════════════════════════
-- admin_console.sql  ·  strict order: before admin_console_rpcs
-- ══════════════════════════════════════════════════════════════════════════
-- ════════════════════════════════════════════════════════════════════════════
-- LAYBELL — ADMIN / MODERATION CONSOLE  ·  Phase 1a: schema + enforcement
-- Paste this WHOLE file into the Supabase Dashboard → SQL Editor and Run.
-- Run admin_console_rpcs.sql NEXT (it defines the functions the console calls).
--
-- Everything is IDEMPOTENT — safe to run more than once. It is ADDITIVE: it does
-- not change how the consumer app files reports, and every new enforcement rule is
-- keyed on a NEW table that starts EMPTY, so running this file changes NOTHING that
-- users see until a moderator actually acts. All OTA-safe (no app rebuild).
--
-- WHY THIS EXISTS
-- The schema was already built anticipating "a future admin tool" (see the note at
-- the bottom of moderation_preservation.sql): reports carry tamper-proof snapshots,
-- legal_hold preserves evidence, and report tables have NO client read policy on
-- purpose — they are meant to be read by a trusted, service-role / admin surface.
-- This migration turns laybell_admins into a real role system and adds the missing
-- moderation spine: an append-only audit log, a unified case/queue layer, first-class
-- account sanctions (warn/suspend/shadow-ban/ban) and a reversible content-takedown
-- primitive — all enforced server-side.
--
-- SEQUENCE
--   Prereqs: laybell_communities.sql (laybell_admins), post_reports.sql,
--   user_reports.sql, conversation_reports.sql, shop.sql, ad_ecosystem.sql,
--   link_safety.sql, group_chats.sql, moderation_preservation.sql, account_hidden.sql.
--   Section 0 checks ALL of them at once and raises a single list of what to run.
--   (account_deletion_sweep.sql is NOT required — we add its resolved_at columns here.)
--
-- ⚠ AFTER RUNNING BOTH SQL FILES: do the ONE manual step at the very bottom of this
--   file (promote your account to the 'owner' role). Then deploy the admin-actions
--   edge function (see docs/ADMIN_CONSOLE.md).
-- ════════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════════
-- 0) PREREQUISITE GUARDS — checks EVERYTHING at once and raises a single list of
--    exactly what to run, so you don't discover missing pieces one error at a time.
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_missing text := '';
begin
  -- report tables + their owning feature files
  if to_regclass('public.laybell_admins')       is null then v_missing := v_missing || E'\n  - laybell_communities.sql   (laybell_admins)'; end if;
  if to_regclass('public.post_reports')         is null then v_missing := v_missing || E'\n  - post_reports.sql          (post_reports)'; end if;
  if to_regclass('public.user_reports')         is null then v_missing := v_missing || E'\n  - user_reports.sql          (user_reports)'; end if;
  if to_regclass('public.conversation_reports') is null then v_missing := v_missing || E'\n  - conversation_reports.sql  (conversation_reports)'; end if;
  if to_regclass('public.shop_reports')         is null then v_missing := v_missing || E'\n  - shop.sql                  (shop_reports, shop_listings)'; end if;
  if to_regclass('public.shop_listings')        is null and to_regclass('public.shop_reports') is not null then v_missing := v_missing || E'\n  - shop.sql                  (shop_listings)'; end if;
  if to_regclass('public.ad_reports')           is null then v_missing := v_missing || E'\n  - ad_ecosystem.sql          (ad_reports, ad_campaigns)'; end if;
  if to_regclass('public.link_reports')         is null then v_missing := v_missing || E'\n  - link_safety.sql           (link_reports, blocked_link_domains)'; end if;
  if to_regclass('public.conversations')        is null then v_missing := v_missing || E'\n  - group_chats.sql           (conversations)'; end if;

  -- moderation_preservation.sql — the evidence spine (snapshots + legal_hold)
  if to_regclass('public.post_reports') is not null
     and not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='post_reports' and column_name='content_snapshot')
  then v_missing := v_missing || E'\n  - moderation_preservation.sql (report snapshots + legal_hold)'; end if;

  -- account_hidden.sql — the app-wide invisibility flag we reuse
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='profiles' and column_name='hidden')
  then v_missing := v_missing || E'\n  - account_hidden.sql        (profiles.hidden)'; end if;

  if v_missing <> '' then
    raise exception E'Admin console prerequisites are missing. Run these in the SQL editor first, then re-run this file:%', v_missing;
  end if;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- 1) laybell_admins — UPGRADE to graded roles (do NOT replace)
--    reviewer < moderator < owner. Existing rows keep working; they default to the
--    LOWEST tier ('reviewer') until you promote them — so nobody silently gains
--    power. disabled_at soft-revokes an admin without losing the audit trail.
-- ════════════════════════════════════════════════════════════════════════════
alter table public.laybell_admins
  add column if not exists role        text not null default 'reviewer'
    check (role in ('owner', 'moderator', 'reviewer')),
  add column if not exists scopes      jsonb,                 -- optional per-surface limits (future)
  add column if not exists added_by    uuid references auth.users(id) on delete set null,
  add column if not exists disabled_at timestamptz;           -- soft-revoke

-- The self-only SELECT policy from laybell_communities.sql stays as-is (a user can
-- see only their own admin row; the roster is never exposed to clients).

-- ── Authorization primitives — the single choke point every admin RPC, the admin
--    edge function, and any admin RLS policy reuses. SECURITY DEFINER so callers
--    don't need direct read access to laybell_admins.
create or replace function public.is_laybell_admin(p_uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.laybell_admins
    where user_id = p_uid and disabled_at is null
  );
$$;

create or replace function public.has_admin_role(p_uid uuid, p_min_role text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.laybell_admins a
    where a.user_id = p_uid
      and a.disabled_at is null
      and (case a.role when 'owner' then 3 when 'moderator' then 2 when 'reviewer' then 1 else 0 end)
          >= (case p_min_role when 'owner' then 3 when 'moderator' then 2 when 'reviewer' then 1 else 99 end)
  );
$$;

-- These take an arbitrary uid — keep them OUT of clients (they run only inside the
-- SECURITY DEFINER admin RPCs / the edge function / the service role).
revoke execute on function public.is_laybell_admin(uuid) from public;
revoke execute on function public.has_admin_role(uuid, text) from public;

-- The ONE admin function the app/console may call directly: "what is MY role?"
-- (returns null for non-admins). Backs the console's login gate.
create or replace function public.current_admin_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.laybell_admins
  where user_id = auth.uid() and disabled_at is null;
$$;
revoke execute on function public.current_admin_role() from public;
grant  execute on function public.current_admin_role() to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- 2) admin_audit_log — the append-only, actor-stamped record of every moderation
--    action. Fills the biggest gap: resolved_at says a report closed but not WHO
--    did WHAT or WHY, and community_mod_log covers communities only. Written ONLY
--    inside the admin RPCs / edge function, in the same transaction as the action.
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.admin_audit_log (
  id             uuid primary key default gen_random_uuid(),
  -- actor_id is a PLAIN uuid with NO foreign key (like target_user_id). A FK with
  -- ON DELETE SET NULL would fire an UPDATE on this row during the delete cascade,
  -- which the append-only trigger below rejects — that would make deleting ANY
  -- account that ever acted as an admin fail, and could wedge the deletion sweep.
  actor_id       uuid,        -- admin who acted (denormalized; survives their deletion)
  actor_role     text,                                                -- role at action time
  action         text not null,                                       -- see the RPCs for the vocabulary
  target_type    text,        -- post|user|story|comment|conversation|shop_listing|ad|community|domain
  target_id      text,        -- text so it holds uuids AND domains
  target_user_id uuid,        -- denormalized subject account (survives target deletion)
  report_subject text,        -- 'type:id' of the case this action closed, if any
  reason         text,        -- moderator-entered rationale
  detail         jsonb,       -- before/after, minutes, ban duration, etc.
  created_at     timestamptz not null default now()
);
-- If a partial earlier run created the FK, drop it (idempotent).
alter table public.admin_audit_log drop constraint if exists admin_audit_log_actor_id_fkey;

create index if not exists admin_audit_target_idx on public.admin_audit_log (target_type, target_id, created_at desc);
create index if not exists admin_audit_subject_idx on public.admin_audit_log (target_user_id, created_at desc);
create index if not exists admin_audit_actor_idx   on public.admin_audit_log (actor_id, created_at desc);

alter table public.admin_audit_log enable row level security;
-- No client policy at all: reads happen via admin_list_audit() (SECURITY DEFINER);
-- writes happen inside the admin RPCs / service role. RLS-locked to everyone else.

-- Append-only: block UPDATE/DELETE (row-level) and TRUNCATE (statement-level) so the
-- log can't be rewritten in the normal course of the app or by the admin RPCs. NOTE:
-- this guarantees immutability against RLS clients and the RPC/edge-fn code paths; a
-- holder of the raw service-role key / a DB superuser can still DROP the triggers or
-- the table, so treat those credentials as the ultimate trust boundary (and, for a
-- true legal record, stream the log to append-only external storage).
create or replace function public.admin_audit_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'admin_audit_log is append-only (no % allowed)', tg_op;
end $$;

drop trigger if exists admin_audit_no_update on public.admin_audit_log;
create trigger admin_audit_no_update before update on public.admin_audit_log
  for each row execute function public.admin_audit_immutable();
drop trigger if exists admin_audit_no_delete on public.admin_audit_log;
create trigger admin_audit_no_delete before delete on public.admin_audit_log
  for each row execute function public.admin_audit_immutable();
drop trigger if exists admin_audit_no_truncate on public.admin_audit_log;
create trigger admin_audit_no_truncate before truncate on public.admin_audit_log
  for each statement execute function public.admin_audit_immutable();

-- Shared writer used by every admin RPC (owner-context; bypasses the RLS lock).
create or replace function public.admin_log(
  p_actor uuid, p_action text, p_target_type text, p_target_id text,
  p_target_user uuid, p_report_subject text, p_reason text, p_detail jsonb
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.admin_audit_log
    (actor_id, actor_role, action, target_type, target_id, target_user_id, report_subject, reason, detail)
  values
    (p_actor, (select role from public.laybell_admins where user_id = p_actor),
     p_action, p_target_type, p_target_id, p_target_user, p_report_subject, p_reason, p_detail);
end $$;
revoke execute on function public.admin_log(uuid, text, text, text, uuid, text, text, jsonb) from public;


-- ════════════════════════════════════════════════════════════════════════════
-- 3) moderation_cases — workflow/dedup overlay. The QUEUE is derived live from the
--    raw report tables (source of truth for "what was reported"); this table holds
--    only the workflow STATE for one subject (N reports on one post = ONE case).
--    Keyed by (subject_type, subject_id-as-text) so it spans uuids and link hosts.
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.moderation_cases (
  id               uuid primary key default gen_random_uuid(),
  subject_type     text not null,   -- post|user|story|conversation|shop_listing|ad|domain
  subject_id       text not null,
  subject_user_id  uuid,            -- the account behind the subject, if any
  status           text not null default 'open'
    check (status in ('open', 'investigating', 'actioned', 'dismissed', 'escalated')),
  severity         text not null default 'medium'
    check (severity in ('low', 'medium', 'high', 'critical')),
  assignee_id      uuid references auth.users(id) on delete set null,
  action_taken     text,
  notes            text,            -- private moderator notes
  escalated_to     text,            -- owner|legal|ncmec
  resolved_by      uuid references auth.users(id) on delete set null,
  resolved_at      timestamptz,
  first_reported_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (subject_type, subject_id)
);
create index if not exists moderation_cases_status_idx  on public.moderation_cases (status, severity, updated_at desc);
create index if not exists moderation_cases_subject_idx on public.moderation_cases (subject_user_id);

alter table public.moderation_cases enable row level security;
-- No client policy: cases are read/written only through the admin RPCs.


-- ════════════════════════════════════════════════════════════════════════════
-- 4) REPORT-TABLE CONSISTENCY BACKFILL
--    Bring conversation/shop/link/ad reports up to the post/user preservation
--    standard: a resolved_at "mark handled" flag everywhere, tamper-proof snapshots
--    where missing, and CASCADE→SET NULL FK flips so deleting the campaign/
--    conversation no longer DESTROYS the report + its evidence.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 4·0) resolved_at on post/user/ad reports. account_deletion_sweep.sql also adds
--    these; we add them here (idempotent) so the console does NOT depend on the
--    deletion sweep being set up. A moderator marks a report handled via resolved_at.
alter table public.post_reports add column if not exists resolved_at timestamptz;
alter table public.user_reports add column if not exists resolved_at timestamptz;
alter table public.ad_reports   add column if not exists resolved_at timestamptz;

-- ── 4a) conversation_reports: mark-handled + metadata snapshot + FK flip ──────
alter table public.conversation_reports
  add column if not exists resolved_at          timestamptz,
  add column if not exists reported_user_id     uuid,     -- conversation creator (kept after delete)
  add column if not exists conversation_snapshot jsonb,   -- conversation METADATA only (never message bodies)
  add column if not exists snapshot_at          timestamptz;

alter table public.conversation_reports alter column conversation_id drop not null;
alter table public.conversation_reports drop constraint if exists conversation_reports_conversation_id_fkey;
alter table public.conversation_reports
  add constraint conversation_reports_conversation_id_fkey
  foreign key (conversation_id) references public.conversations(id) on delete set null;

-- Snapshot the conversation METADATA (id/creator/members) — deliberately NOT the
-- message bodies: 1:1 and group message contents are private (Privacy Policy) and
-- there is no admin read path into them today. Preserving who/what was reported is
-- enough for triage; full message preservation is a Phase 4 legal decision.
create or replace function public.snapshot_conversation_report()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  select c.created_by,
         jsonb_build_object(
           'id', c.id, 'created_by', c.created_by, 'created_at', c.created_at,
           'member_count', (select count(*) from public.conversation_members m where m.conversation_id = c.id))
    into new.reported_user_id, new.conversation_snapshot
    from public.conversations c
   where c.id = new.conversation_id;
  new.snapshot_at := now();
  return new;
end $$;
drop trigger if exists conversation_reports_snapshot on public.conversation_reports;
create trigger conversation_reports_snapshot
  before insert on public.conversation_reports
  for each row execute function public.snapshot_conversation_report();

-- ── 4b) shop_reports: mark-handled + full listing snapshot ────────────────────
--    (listing_id + seller_id are already ON DELETE SET NULL — preservation-safe.)
alter table public.shop_reports
  add column if not exists resolved_at       timestamptz,
  add column if not exists reported_snapshot jsonb,       -- full listing at report time
  add column if not exists snapshot_at       timestamptz;

create or replace function public.snapshot_shop_report()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  select to_jsonb(l), l.user_id
    into new.reported_snapshot, new.seller_id
    from public.shop_listings l
   where l.id = new.listing_id;
  new.snapshot_at := now();
  return new;
end $$;
drop trigger if exists shop_reports_snapshot on public.shop_reports;
create trigger shop_reports_snapshot
  before insert on public.shop_reports
  for each row execute function public.snapshot_shop_report();

-- ── 4c) link_reports: mark-handled ────────────────────────────────────────────
alter table public.link_reports
  add column if not exists resolved_at timestamptz;

-- ── 4d) ad_reports: capture the campaign owner + creative snapshot; FK flip so a
--        deleted campaign no longer CASCADE-destroys the report (it was the only
--        report table still on CASCADE). resolved_at already added by the sweep.
alter table public.ad_reports
  add column if not exists reported_user_id  uuid,        -- campaign owner (kept after delete)
  add column if not exists creative_snapshot jsonb,
  add column if not exists snapshot_at       timestamptz;

alter table public.ad_reports alter column campaign_id drop not null;
alter table public.ad_reports drop constraint if exists ad_reports_campaign_id_fkey;
alter table public.ad_reports
  add constraint ad_reports_campaign_id_fkey
  foreign key (campaign_id) references public.ad_campaigns(id) on delete set null;

create or replace function public.snapshot_ad_report()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  select c.user_id,
         to_jsonb(cr)
    into new.reported_user_id, new.creative_snapshot
    from public.ad_campaigns c
    left join public.ad_creatives cr on cr.id = new.creative_id
   where c.id = new.campaign_id;
  new.snapshot_at := now();
  return new;
end $$;
drop trigger if exists ad_reports_snapshot on public.ad_reports;
create trigger ad_reports_snapshot
  before insert on public.ad_reports
  for each row execute function public.snapshot_ad_report();

-- ── 4e) backfill reported_user_id on EXISTING ad/conversation reports (the trigger
--    only fills new rows). Keeps the queue attributing historical reports to the right
--    account, and makes the open-report gate robust if the campaign/conversation is
--    ever hard-deleted (its FK is now SET NULL). Snapshots for old rows can't be
--    reconstructed, but the owner link can. Idempotent (only touches null rows).
update public.ad_reports ar
   set reported_user_id = c.user_id
  from public.ad_campaigns c
 where c.id = ar.campaign_id and ar.reported_user_id is null;

update public.conversation_reports cr
   set reported_user_id = c.created_by
  from public.conversations c
 where c.id = cr.conversation_id and cr.reported_user_id is null;


-- ════════════════════════════════════════════════════════════════════════════
-- 5) user_sanctions — first-class account moderation state the app side lacks
--    entirely today (ban lived ONLY as auth.users.ban_duration, no unban path, no
--    strike count). One CURRENT-state row per user; the full history lives in
--    admin_audit_log. Enforced server-side by restrictive RLS (Section 7) so a
--    suspend / shadow-ban / ban actually DOES something without deleting data.
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.user_sanctions (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  state           text not null default 'active'
    check (state in ('active', 'warned', 'suspended', 'shadow_banned', 'banned')),
  suspended_until timestamptz,             -- when a 'suspended' state auto-lifts
  strike_count    integer not null default 0,
  reason          text,
  actor_id        uuid references auth.users(id) on delete set null,
  auth_ban_synced boolean not null default false,  -- true once the edge fn set auth.users ban_duration
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists user_sanctions_state_idx on public.user_sanctions (state);

alter table public.user_sanctions enable row level security;
-- No client policy: a user must NOT be able to read whether they are shadow-banned,
-- nor see others' sanction state. All access is through the admin RPCs / helpers.

-- Enforcement helpers (SECURITY DEFINER so they see the RLS-locked table).
--  * hidden   → shadow_banned or banned: their content is invisible to others.
--  * blocked  → banned, or an ACTIVE suspension: they cannot create new content.
-- Shadow-banned users can still POST (so it looks normal to them) — their content
-- is just hidden — so shadow_ban does NOT block posting.
--
-- ⚠ These live in a PRIVATE schema, NOT public. Because they are SECURITY DEFINER
-- and bypass the RLS lock on user_sanctions, exposing them as PostgREST RPCs would
-- let ANY client probe "is user X shadow-banned/suspended/banned?" — which defeats
-- shadow-ban (its whole point is secrecy). PostgREST only exposes public/graphql_public,
-- so putting them in `private` makes them unreachable as RPCs while the RLS policies
-- (which reference them fully-qualified) can still call them. authenticated/anon get
-- USAGE + EXECUTE so policy evaluation during a normal query is permitted.
create schema if not exists private;
grant usage on schema private to authenticated, anon;

-- Drop any public.* versions a partial earlier run may have created (they'd be
-- RPC-exposed — remove them so the leak can't exist).
drop function if exists public.user_content_hidden(uuid);
drop function if exists public.user_posting_blocked(uuid);

create or replace function private.user_content_hidden(p_uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_sanctions s
    where s.user_id = p_uid and s.state in ('shadow_banned', 'banned')
  );
$$;

create or replace function private.user_posting_blocked(p_uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_sanctions s
    where s.user_id = p_uid
      and (s.state = 'banned'
        or (s.state = 'suspended' and coalesce(s.suspended_until, 'infinity'::timestamptz) > now()))
  );
$$;
grant execute on function private.user_content_hidden(uuid)  to authenticated, anon;
grant execute on function private.user_posting_blocked(uuid) to authenticated, anon;


-- ════════════════════════════════════════════════════════════════════════════
-- 6) content_takedowns — the missing NON-DESTRUCTIVE moderator takedown. Posts had
--    only the owner's archived_at; stories/comments/listings had nothing but hard
--    delete. A polymorphic row HIDES a single item app-wide (evidence preserved,
--    reversible, appealable) — the complement to legal_hold ("preserve") with a
--    "take down but keep" state.
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.content_takedowns (
  id                uuid primary key default gen_random_uuid(),
  content_type      text not null,     -- post|story|comment|shop_listing (enforced below); playlist|ad_creative|message (stored, enforce later)
  content_id        uuid not null,
  owner_id          uuid,              -- author of the content (for the queue / audit)
  active            boolean not null default true,
  reason            text,
  actor_id          uuid references auth.users(id) on delete set null,
  legal_hold_linked boolean not null default false,
  created_at        timestamptz not null default now(),
  restored_at       timestamptz,
  restored_by       uuid references auth.users(id) on delete set null,
  unique (content_type, content_id)
);
create index if not exists content_takedowns_active_idx on public.content_takedowns (content_type, content_id) where active;

alter table public.content_takedowns enable row level security;
-- No client policy: managed only through the admin RPCs.

-- Private (non-RPC-exposed) helper, same reasoning as the sanction helpers above.
drop function if exists public.content_taken_down(text, uuid);
create or replace function private.content_taken_down(p_type text, p_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.content_takedowns t
    where t.content_type = p_type and t.content_id = p_id and t.active
  );
$$;
grant execute on function private.content_taken_down(text, uuid) to authenticated, anon;


-- ════════════════════════════════════════════════════════════════════════════
-- 7) SERVER-SIDE ENFORCEMENT (restrictive RLS)
--    These AND with the existing permissive policies — mirroring the account_hidden
--    pattern. Every rule is keyed on a NEW table that starts EMPTY, so applying this
--    section changes NOTHING until a moderator sanctions a user or takes content
--    down. Owners always keep their own SELECT (except for taken-down items, which
--    vanish for everyone — a takedown is a full removal, preserved only for review).
--
--    ⚠ These touch the live app's read AND write path. After running, smoke-test as
--    a NORMAL (non-sanctioned) user: viewing feeds, and creating a post / comment /
--    DM should all still work exactly as before (the helpers return false for
--    everyone while the tables are empty).
-- ════════════════════════════════════════════════════════════════════════════

-- ── 7a) Hide a shadow-banned / banned author's content (SELECT) ───────────────
drop policy if exists "Sanctioned authors' posts are invisible" on public.posts;
create policy "Sanctioned authors' posts are invisible"
  on public.posts as restrictive for select
  using (user_id = auth.uid() or not private.user_content_hidden(user_id));

drop policy if exists "Sanctioned authors' stories are invisible" on public.stories;
create policy "Sanctioned authors' stories are invisible"
  on public.stories as restrictive for select
  using (user_id = auth.uid() or not private.user_content_hidden(user_id));

drop policy if exists "Sanctioned authors' playlists are invisible" on public.playlists;
create policy "Sanctioned authors' playlists are invisible"
  on public.playlists as restrictive for select
  using (user_id = auth.uid() or not private.user_content_hidden(user_id));

-- ── 7b) Hide individually taken-down items (SELECT) from OTHERS ───────────────
--    The author keeps seeing their own item (`user_id = auth.uid() or …`), same as
--    account_hidden. Without that exception a taken-down row is invisible to its
--    owner, so the app's `delete().eq('id',…)` matches 0 rows (RLS SELECT is checked
--    on delete's WHERE) — the owner "deletes" it, nothing happens, and a later
--    admin_restore_content resurrects content the owner thought was gone. Keeping it
--    owner-visible lets them still delete it; evidence that must survive deletion is
--    frozen with legal_hold, not a takedown.
drop policy if exists "Taken-down posts are invisible" on public.posts;
create policy "Taken-down posts are invisible"
  on public.posts as restrictive for select
  using (user_id = auth.uid() or not private.content_taken_down('post', id));

drop policy if exists "Taken-down stories are invisible" on public.stories;
create policy "Taken-down stories are invisible"
  on public.stories as restrictive for select
  using (user_id = auth.uid() or not private.content_taken_down('story', id));

drop policy if exists "Taken-down listings are invisible" on public.shop_listings;
create policy "Taken-down listings are invisible"
  on public.shop_listings as restrictive for select
  using (user_id = auth.uid() or not private.content_taken_down('shop_listing', id));

-- ── 7c) Block a suspended / banned user from creating new content (INSERT) ─────
drop policy if exists "Blocked users cannot post" on public.posts;
create policy "Blocked users cannot post"
  on public.posts as restrictive for insert
  with check (not private.user_posting_blocked(auth.uid()));

drop policy if exists "Blocked users cannot post stories" on public.stories;
create policy "Blocked users cannot post stories"
  on public.stories as restrictive for insert
  with check (not private.user_posting_blocked(auth.uid()));

drop policy if exists "Blocked users cannot message" on public.messages;
create policy "Blocked users cannot message"
  on public.messages as restrictive for insert
  with check (not private.user_posting_blocked(auth.uid()));

-- ── 7d) comments — the base `comments` table is NOT defined in supabase/sql (it
--    predates this file / was made in the dashboard), so we don't know if RLS is
--    on. `create policy` never errors when RLS is off, it just does NOTHING — which
--    would make comment takedown / comment-blocking SILENTLY not enforce. So we
--    create the two comment policies ONLY when RLS is actually enabled on comments,
--    and print a NOTICE telling you how to turn it on otherwise.
do $$
begin
  if exists (select 1 from pg_class where oid = 'public.comments'::regclass and relrowsecurity) then
    -- shadow-ban: hide a sanctioned author's comments from others. Shadow-banned
    -- users are deliberately still allowed to comment (user_posting_blocked excludes
    -- them), so WITHOUT this their comments would stay visible to everyone — the exact
    -- abuse the shadow-ban is meant to silence.
    drop policy if exists "Sanctioned authors' comments are invisible" on public.comments;
    create policy "Sanctioned authors' comments are invisible"
      on public.comments as restrictive for select
      using (user_id = auth.uid() or not private.user_content_hidden(user_id));

    -- individual comment takedown (owner still sees their own; see 7b rationale)
    drop policy if exists "Taken-down comments are invisible" on public.comments;
    create policy "Taken-down comments are invisible"
      on public.comments as restrictive for select
      using (user_id = auth.uid() or not private.content_taken_down('comment', id));

    drop policy if exists "Blocked users cannot comment" on public.comments;
    create policy "Blocked users cannot comment"
      on public.comments as restrictive for insert
      with check (not private.user_posting_blocked(auth.uid()));
  else
    raise notice 'comments RLS is OFF — comment takedown + comment shadow-ban/blocking are NOT enforced. Enable RLS on public.comments (with its existing read/write policies) then re-run this file to activate them.';
  end if;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- Done with Phase 1a. NEXT: run supabase/sql/admin_console_rpcs.sql.
--
-- Then come back and do this ONE manual step — promote your account to 'owner'
-- (find your id first). Everyone in laybell_admins is a 'reviewer' until promoted:
--
--   select id, email from auth.users where email = 'you@example.com';
--
--   insert into public.laybell_admins (user_id, role)
--     values ('<YOUR-AUTH-USER-ID>', 'owner')
--     on conflict (user_id) do update set role = 'owner', disabled_at = null;
-- ════════════════════════════════════════════════════════════════════════════


