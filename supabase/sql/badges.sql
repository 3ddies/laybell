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
-- day"). The client's evaluator (lib/badges.ts) reads a 31-day window via
-- get_badge_state(), derives streaks/criteria, and reconciles which badges the
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
  updated_at     timestamptz not null default now(),
  primary key (user_id, day)
);

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
  add column if not exists story_ring_style text;

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
     set likes         = likes         + (case when p_category = 'likes'         then p_count else 0 end),
         comments      = comments      + (case when p_category = 'comments'      then p_count else 0 end),
         music_seconds = music_seconds + (case when p_category = 'music_seconds' then p_count else 0 end),
         posts_created = posts_created + (case when p_category = 'posts_created' then p_count else 0 end),
         updated_at    = now()
   where user_id = v_uid and day = v_day;
end;
$$;

grant execute on function public.record_badge_activity(text, integer) to authenticated;

-- ─── get_badge_state ──────────────────────────────────────────────────────────
-- One round trip for the evaluator: the current UTC date, the caller's last
-- 31 daily rows (newest first), and their live public-post count using the SAME
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
      select day, likes, comments, music_seconds, posts_created
        from public.user_activity_daily
       where user_id = v_uid
         and day >= v_today - 31
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
-- Not required for correctness (the evaluator only ever looks back ~31 days).
-- Housekeeping only — run manually, or schedule with pg_cron:
--   select cron.schedule('purge-badge-activity', '30 3 * * *', $$select public.purge_old_badge_activity()$$);
create or replace function public.purge_old_badge_activity()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.user_activity_daily
   where day < (now() at time zone 'utc')::date - 60;
$$;
