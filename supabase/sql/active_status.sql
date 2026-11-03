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
  -- Alias + qualify: `returns table(id uuid)` puts an OUT column named `id` in
  -- scope, so an UNqualified `id` here is ambiguous with it and Postgres throws
  -- "column reference \"id\" is ambiguous" on EVERY authenticated call — which
  -- silently killed the whole feature (the client swallows the error). Qualify
  -- via the `pr` alias so `id` can only mean the column.
  if not exists (
    select 1 from public.profiles pr
    where pr.id = auth.uid() and pr.active_status_enabled
  ) then
    return;
  end if;
  return query
    select p.id
      from public.profiles p
     where p.id = any(ids)
       and p.active_status_enabled
       and p.last_active_at is not null
       and p.last_active_at > now() - interval '2 minutes'
       -- TESTING ONLY (remove when done): the @laybell brand account's Active Status is
       -- hidden from EVERYONE except @3ddie, so the owner can test presence without the
       -- brand account showing as online to real users. laybell / 3ddie ids below.
       and not (p.id = '0ca340d6-2d95-4038-88da-4a3dc9b5b9fd'
                and auth.uid() <> 'd0f25dc3-b34c-400e-b380-4a5e83d6b018');
end;
$$;

-- Active-now rail (Messages): up to p_limit users who are online RIGHT NOW. The caller
-- passes the people it wants FIRST in p_prefer — friends, then everyone else they
-- follow — and those fill the slots in that order; any slots still open fill with other
-- online users, most-recently-active first. So the rail still shows faces on a near-
-- empty app, yet never shows a stranger while 5 of your own people are active. Same
-- reciprocity, 2-minute window, and @laybell test-gate as online_user_ids; also skips
-- hidden accounts and anyone on either side of a block.
create or replace function public.active_now(p_prefer uuid[], p_limit int)
returns table(id uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.profiles pr
    where pr.id = auth.uid() and pr.active_status_enabled
  ) then
    return;
  end if;
  return query
    select p.id
      from public.profiles p
     where p.id <> auth.uid()
       and p.active_status_enabled
       and p.last_active_at is not null
       and p.last_active_at > now() - interval '2 minutes'
       and coalesce(p.hidden, false) = false
       and not (p.id = '0ca340d6-2d95-4038-88da-4a3dc9b5b9fd'
                and auth.uid() <> 'd0f25dc3-b34c-400e-b380-4a5e83d6b018')
       and not exists (
         select 1 from public.blocks b
         where (b.blocker_id = auth.uid() and b.blocked_id = p.id)
            or (b.blocker_id = p.id and b.blocked_id = auth.uid())
       )
     order by coalesce(array_position(p_prefer, p.id), 2147483647) asc,
              p.last_active_at desc
     limit greatest(0, least(coalesce(p_limit, 5), 50));
end;
$$;

-- Lockdown (verbatim from profile_views.sql): no public, no anon; authenticated only.
revoke all on function public.touch_active() from public;
revoke all on function public.touch_active() from anon;
grant execute on function public.touch_active() to authenticated;

revoke all on function public.online_user_ids(uuid[]) from public;
revoke all on function public.online_user_ids(uuid[]) from anon;
grant execute on function public.online_user_ids(uuid[]) to authenticated;

revoke all on function public.active_now(uuid[], int) from public;
revoke all on function public.active_now(uuid[], int) from anon;
grant execute on function public.active_now(uuid[], int) to authenticated;
