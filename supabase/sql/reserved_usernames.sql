-- Reserved usernames.  2026-08-21.
--
--   npx supabase db query --linked -f supabase/sql/reserved_usernames.sql
--
-- ─── WHY THIS EXISTS RIGHT NOW ──────────────────────────────────────────────
-- `lib/badges.ts:628` still carries a block marked "TEMP TESTING OVERRIDE —
-- REMOVE BEFORE RELEASE":
--
--     const TEST_FORCE_TIER: Record<string, Tier> = {
--       observer: 'diamond',
--       rachaelhall: 'gold',
--     };
--
-- It is compiled into build 4, which Apple approved and both stores are shipping.
-- `evaluateBadges()` matches it on **username**, not user id, and short-circuits
-- the normal recompute — so whoever holds one of those names is handed the tier.
--
-- The fresh-start reset on 2026-08-21 deleted both accounts, which FREED the
-- names. Anyone registering `observer` would receive a Diamond emblem, and with
-- it the Diamond-gated ability to create communities (communities.sql:380);
-- `rachaelhall` would receive Gold, which gates community management.
--
-- Removing the map needs a rebuild. Blocking the names does not, so this is the
-- server-side half of the fix and it takes effect immediately.
--
-- ⚠️ SAFE TO DROP once a build ships with TEST_FORCE_TIER emptied — but there is
-- no harm in keeping it, and a reserved-name list is worth having anyway.

create table if not exists public.reserved_usernames (
  username text primary key,   -- always stored lowercase
  reason   text not null,
  added_at timestamptz not null default now()
);

alter table public.reserved_usernames enable row level security;
-- No policy at all: nobody reads or writes this from the client. The trigger
-- below is security definer, so it sees the table regardless.

insert into public.reserved_usernames (username, reason) values
  ('observer',    'TEST_FORCE_TIER grants diamond to this username in shipped build 4'),
  ('rachaelhall', 'TEST_FORCE_TIER grants gold to this username in shipped build 4')
on conflict (username) do nothing;

create or replace function public.reject_reserved_username()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.username is not null
     and exists (select 1 from public.reserved_usernames r
                  where r.username = lower(new.username)) then
    -- Deliberately vague to the caller: naming the reason would advertise which
    -- usernames carry a privilege, which is the thing being protected.
    raise exception 'username_unavailable';
  end if;
  return new;
end $$;

drop trigger if exists profiles_reject_reserved_username on public.profiles;
create trigger profiles_reject_reserved_username
  before insert or update of username on public.profiles
  for each row execute function public.reject_reserved_username();

-- ─── Verify ─────────────────────────────────────────────────────────────────
select
  (select count(*) from public.reserved_usernames)                         as reserved_count,
  (select count(*) from public.profiles
    where lower(username) in (select username from public.reserved_usernames)) as violations_must_be_0;
