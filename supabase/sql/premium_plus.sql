-- ───────────────────────────────────────────────────────────────────────────
-- Premium+ ($19.99/mo) — the tier above Premium, and the Films backbone.
-- Run in the Supabase Dashboard → SQL Editor (or supabase db query --linked).
--
-- Two perks live server-side:
--   • FILMS — only active Premium+ subscribers may post videos longer than the
--     free 9-minute landscape window. A film is any video post with
--     duration_seconds > 540 (verticals cap at 3 minutes, so only landscape
--     videos can cross the line).
--   • BADGE FREEZE is client-side (lib/badges.ts) — nothing here.
--
-- Lapsed-subscriber film lifecycle (owner agreed 2026-08-05):
--   lapse → films SUSPENDED immediately (hidden app-wide via archived_at, which
--   every surface already filters) → HARD-DELETED after 7 days. Resubscribing
--   inside the window restores them exactly as they were. The 7-day hold costs
--   pennies of storage and turns a rage-cancel into a recoverable event.
--
-- Cloudflare cleanup: deleting a posts row does NOT delete the Stream asset —
-- that needs an HTTP call, and pg_net is not installed here. So every deleted
-- video post queues its asset uid into stream_reap_queue, and the stream-reap
-- Edge Function (service role, invoked opportunistically at app boot) drains
-- the queue. This also closes a pre-existing hole: posts deleted by cascade
-- (account deletion) used to orphan their Cloudflare assets forever.
--
-- Idempotent; safe to re-run.
-- ───────────────────────────────────────────────────────────────────────────

-- 1) The entitlement mirror, same contract as premium_until: written ONLY by
--    the revenuecat-webhook (service role), protected from self-grant below.
alter table public.profiles
  add column if not exists premium_plus_until timestamptz;

create or replace function public.is_premium_plus(p_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select premium_plus_until from public.profiles where id = p_id) > now(), false);
$$;
grant execute on function public.is_premium_plus(uuid) to authenticated;
revoke execute on function public.is_premium_plus(uuid) from anon;

-- Premium+ is a SUPERSET of Premium: either active subscription counts as
-- premium. (The webhook writes each product's own column only; the superset
-- lives here, so a plus expiry can never clobber a separate live premium sub.)
create or replace function public.is_premium(p_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select premium_until from public.profiles where id = p_id) > now(), false)
      or coalesce((select premium_plus_until from public.profiles where id = p_id) > now(), false);
$$;

-- MONEY: tip_fee_rate() (ledger_spend.sql) is the ONE definition of the tip
-- fee, and it read premium_until directly — so a Premium+ subscriber would
-- have paid the STANDARD rate on tips despite paying for the higher tier.
-- Redefined here through is_premium(), which now covers both columns.
create or replace function public.tip_fee_rate(p_host uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select case when public.is_premium(p_host) then 0.30 else 0.35 end;
$$;

-- Self-grant guard, extended to cover both entitlement columns.
create or replace function public.protect_premium_until()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then
    if new.premium_until is distinct from old.premium_until then
      new.premium_until := old.premium_until;
    end if;
    if new.premium_plus_until is distinct from old.premium_plus_until then
      new.premium_plus_until := old.premium_plus_until;
    end if;
  end if;
  return new;
end; $$;

drop trigger if exists profiles_protect_premium on public.profiles;
create trigger profiles_protect_premium
  before update on public.profiles
  for each row execute function public.protect_premium_until();


-- 2) Film columns. film_title is the movie-shelf display name (the rail shows
--    poster + title; captions make bad movie titles). film_suspended_at marks
--    a film hidden BY THE LAPSE REAPER — distinct from archived_at so a user's
--    own archives are never confused with suspensions, and so restore knows
--    exactly which rows it may touch.
alter table public.posts
  add column if not exists film_title text;
alter table public.posts
  add column if not exists film_suspended_at timestamptz;

-- 3) The gate: only active Premium+ may post (or lengthen a video into) a film.
--    Fires only when duration actually crosses/changes, so a lapsed subscriber
--    editing the caption of a grace-period film is not rejected by their own
--    edit. The client enforces this politely (upsell); this is the backstop —
--    the REAL length ceiling is server-side at upload-URL mint time, which a
--    modified client cannot cross.
create or replace function public.enforce_film_rights()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.type = 'video'
     and coalesce(new.duration_seconds, 0) > 540
     and (tg_op = 'INSERT' or new.duration_seconds is distinct from old.duration_seconds)
     and not public.is_premium_plus(new.user_id) then
    raise exception 'film_requires_premium_plus';
  end if;
  -- Server cap on the shelf title; the client caps politely first.
  if new.film_title is not null then
    new.film_title := nullif(left(btrim(new.film_title), 120), '');
  end if;
  return new;
end; $$;

drop trigger if exists posts_enforce_film_rights on public.posts;
create trigger posts_enforce_film_rights
  before insert or update on public.posts
  for each row execute function public.enforce_film_rights();

-- The Films rail: newest/most-streamed films. Partial → tiny.
create index if not exists posts_films_idx
  on public.posts (created_at desc)
  where type = 'video' and duration_seconds > 540;

-- 4) Cloudflare asset reaping for DELETED video posts (films or not).
create table if not exists public.stream_reap_queue (
  uid       text primary key,
  queued_at timestamptz not null default now()
);
alter table public.stream_reap_queue enable row level security;
-- No policies on purpose: only the service role (stream-reap fn) reads/clears.

create or replace function public.queue_stream_reap()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.video_uid is not null then
    insert into public.stream_reap_queue (uid) values (old.video_uid)
    on conflict (uid) do nothing;
  end if;
  return old;
end; $$;

drop trigger if exists posts_queue_stream_reap on public.posts;
create trigger posts_queue_stream_reap
  after delete on public.posts
  for each row execute function public.queue_stream_reap();

-- 5) The lapse reaper: suspend → (7 days) → delete, and restore on resubscribe.
create or replace function public.reap_lapsed_films()
returns table (suspended int, restored int, deleted int)
language plpgsql security definer set search_path = public as $$
declare
  v_susp int; v_rest int; v_del int;
begin
  -- Films whose owner's Premium+ has lapsed → hide app-wide. archived_at is
  -- what every feed/grid/rail already filters; film_suspended_at records that
  -- WE did it (and starts the 7-day deletion clock).
  with s as (
    update public.posts p
       set film_suspended_at = now(),
           archived_at = coalesce(p.archived_at, now())
     where p.type = 'video'
       and p.duration_seconds > 540
       and p.film_suspended_at is null
       and not public.is_premium_plus(p.user_id)
    returning 1
  ) select count(*)::int into v_susp from s;

  -- Resubscribed inside the window → films come back exactly as they were.
  -- (If the owner had ALSO archived one manually before lapsing, restore
  -- unarchives it too — a one-tap re-archive, accepted for simplicity.)
  with r as (
    update public.posts p
       set film_suspended_at = null,
           archived_at = null
     where p.film_suspended_at is not null
       and public.is_premium_plus(p.user_id)
    returning 1
  ) select count(*)::int into v_rest from r;

  -- Grace over → gone for real. The delete trigger above queues each film's
  -- Cloudflare asset, so storage costs actually stop.
  with d as (
    delete from public.posts p
     where p.film_suspended_at is not null
       and p.film_suspended_at < now() - interval '7 days'
    returning 1
  ) select count(*)::int into v_del from d;

  return query select v_susp, v_rest, v_del;
end; $$;

-- Server-side only — exposing this would let anyone suspend/delete films.
revoke all on function public.reap_lapsed_films() from public;
revoke execute on function public.reap_lapsed_films() from anon, authenticated;

-- Hourly is plenty: nothing here is time-critical to the minute.
do $$
begin
  perform cron.unschedule('reap-lapsed-films');
exception when others then null;   -- not scheduled yet
end $$;
select cron.schedule('reap-lapsed-films', '17 * * * *', 'select public.reap_lapsed_films()');

-- Verify.
select jobid, schedule, active from cron.job where jobname = 'reap-lapsed-films';
select p.proname, array_to_string(p.proacl::text[], ' | ') as acl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('is_premium_plus', 'reap_lapsed_films', 'enforce_film_rights');
