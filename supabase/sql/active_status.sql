-- Active Status — the green "online now" dot (1.0.9).
--
-- A reciprocal, OPT-OUT presence signal, ON by default, modelled exactly on
-- profile_views.sql. Two rules, both enforced here on the server so a client can't
-- cheat them:
--   • A user who turns their Active Status OFF is never shown as online to anyone.
--   • A user who turns it OFF also sees NO ONE as online (reciprocal — the same deal
--     as "last seen" on the big messengers).
--
-- We add a NEW column (last_active_at) rather than reuse profiles.last_seen_at: that
-- one is stamped once per app-open and is load-bearing for the account-deletion sweep
-- and the re-engagement "absence" nudges, so a frequent heartbeat would quietly break
-- both. Keep the two concerns separate.

alter table public.profiles
  add column if not exists last_active_at timestamptz;

-- Opt-out flag: add-if-not-exists + set-default + backfill (so it flips on even on a
-- DB where the column somehow first shipped false). Mirrors profile_views_enabled.
alter table public.profiles
  add column if not exists active_status_enabled boolean not null default true;
alter table public.profiles alter column active_status_enabled set default true;
update public.profiles set active_status_enabled = true where active_status_enabled is distinct from true;

-- Heartbeat: stamp MY own activity — but only while I'm opted in. An opted-out user's
-- timestamp therefore freezes and never leaks current activity, even on a raw column
-- read. Called ~every 60s while the app is foregrounded (see lib/onlineStatus.ts).
create or replace function public.touch_active()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
     set last_active_at = now()
   where id = auth.uid() and active_status_enabled;
end;
$$;

-- Read: of the given ids, which are online RIGHT NOW. Gated reciprocally —
--   • returns NOTHING if the caller has their own Active Status off;
--   • never includes a user who has theirs off;
--   • 2-minute freshness window (a foregrounded client re-stamps well inside that).
-- Returns table(id uuid) so supabase-js hands back [{ id }, ...] unambiguously.
create or replace function public.online_user_ids(ids uuid[])
returns table(id uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and active_status_enabled
  ) then
    return;
  end if;
  return query
    select p.id
      from public.profiles p
     where p.id = any(ids)
       and p.active_status_enabled
       and p.last_active_at is not null
       and p.last_active_at > now() - interval '2 minutes';
end;
$$;

-- Lockdown (verbatim from profile_views.sql): no public, no anon; authenticated only.
revoke all on function public.touch_active() from public;
revoke all on function public.touch_active() from anon;
grant execute on function public.touch_active() to authenticated;

revoke all on function public.online_user_ids(uuid[]) from public;
revoke all on function public.online_user_ids(uuid[]) from anon;
grant execute on function public.online_user_ids(uuid[]) to authenticated;
