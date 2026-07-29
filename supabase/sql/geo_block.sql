-- Region blocking — Mississippi HB 1126.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
--
-- WHY THIS EXISTS
-- Mississippi's Walker Montgomery Protecting Children Online Act (HB 1126)
-- requires commercially reasonable age verification for every user, verifiable
-- parental consent for minors, and a design duty toward minors. Unlike almost
-- every comparable state law, IT HAS NO SIZE THRESHOLD — it binds a service with
-- ten users exactly as it binds one with ten million. Enforcement is by the
-- state Attorney General, per violation.
--
-- Laybell's answer for v1 is not to serve Mississippi. Third-party age assurance
-- costs roughly $0.30–$2.00 per verification, which is unaffordable pre-revenue,
-- and an identity check standing between a stranger and their first look at the
-- app is the single most reliable way to kill a young social product. Mississippi
-- is ~1% of the US population. That is the cheaper mistake.
--
-- THIS IS EXPECTED TO BE TEMPORARY. Utah, Texas, Louisiana, Arkansas, Florida,
-- Tennessee and others have passed comparable laws in varying states of
-- injunction, and that status changes month to month. When Laybell can afford
-- real age assurance, this list should shrink to nothing. Everything here is
-- built to be lifted: no data is destroyed, and unblocking is one UPDATE.
--
-- WHY THE ENFORCEMENT IS HERE AND NOT IN THE APP
-- A client-side check would be decorative. `profiles` rows are created by the
-- handle_new_user() trigger on auth.users, which is deliberately failure-tolerant
-- ("NEVER block account creation over the profile row"), AND by
-- ensureProfileForSession() on first login, AND social sign-in skips the signup
-- screen entirely — three paths that never execute app code. So the app layer is
-- UX, and this file is the control. Same division as minor_safety.sql.

-- ─── Column ─────────────────────────────────────────────────────────────────
-- `region_code` is the USPS code the user selected during onboarding.
-- `region_blocked_at` is set when that selection lands in a blocked region.
--
-- Two columns rather than one derived check, because the block must SURVIVE the
-- list changing. If Mississippi is later removed from the blocked list, existing
-- blocked accounts should be reviewed and lifted deliberately, not silently
-- resurrected by an unrelated deploy.
alter table public.profiles add column if not exists region_code       text;
alter table public.profiles add column if not exists region_blocked_at timestamptz;

create index if not exists profiles_region_blocked_idx
  on public.profiles (region_blocked_at)
  where region_blocked_at is not null;


-- ─── The list ───────────────────────────────────────────────────────────────
-- A table rather than a hardcoded constant so a region can be unblocked without
-- a deploy — this list will change faster than the app ships, and being stuck
-- blocking a state whose law got enjoined is a self-inflicted wound.
--
-- Keep in sync with BLOCKED_REGIONS in lib/geoBlock.ts, which is the app-side
-- copy used for the onboarding message.
create table if not exists public.blocked_regions (
  region_code text primary key,
  country     text not null default 'US',
  reason      text not null,
  added_at    timestamptz not null default now()
);

insert into public.blocked_regions (region_code, reason) values
  ('MS', 'Mississippi HB 1126 — age verification and parental consent with no size threshold. Revisit when age assurance is affordable.')
on conflict (region_code) do nothing;

alter table public.blocked_regions enable row level security;

-- Readable by anyone signed in: the app needs it to explain the block, and the
-- list of US states a service declines to operate in is not a secret. Writes are
-- service-role only (no policy grants insert/update/delete).
drop policy if exists "Blocked regions are readable" on public.blocked_regions;
create policy "Blocked regions are readable"
  on public.blocked_regions for select
  to authenticated
  using (true);


-- ─── Recording a region ─────────────────────────────────────────────────────
-- Called from onboarding. SECURITY DEFINER so the block stamp is applied by the
-- server against the server's own list — a client that simply omitted the
-- `region_blocked_at` write must not be able to opt out of being blocked.
--
-- Returns true when the caller is blocked, so the app can react immediately
-- rather than waiting for the next session check.
create or replace function public.set_region(p_region_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code    text;
  v_blocked boolean;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  v_code := upper(nullif(btrim(p_region_code), ''));
  if v_code is null or v_code !~ '^[A-Z]{2}$' then
    raise exception 'region_code must be a two-letter code';
  end if;

  select exists (
    select 1 from public.blocked_regions br where br.region_code = v_code
  ) into v_blocked;

  update public.profiles p
     set region_code       = v_code,
         -- Never clear an existing stamp here. Lifting a block is a deliberate
         -- act (see "Unblocking" below), not something a user achieves by
         -- re-running onboarding and picking a different state.
         region_blocked_at = case
                               when p.region_blocked_at is not null then p.region_blocked_at
                               when v_blocked then now()
                               else null
                             end
   where p.id = auth.uid();

  return v_blocked or exists (
    select 1 from public.profiles p2
     where p2.id = auth.uid() and p2.region_blocked_at is not null
  );
end $$;

grant execute on function public.set_region(text) to authenticated;


-- ─── The gate ───────────────────────────────────────────────────────────────
-- SECURITY DEFINER so it can read profiles regardless of the caller's own RLS,
-- STABLE so Postgres caches it within a statement rather than re-running it per
-- row.
--
-- NOTE THE ASYMMETRY, which matches lib/minors.ts: this returns true only for a
-- user AFFIRMATIVELY KNOWN to be in a blocked region. A user with no region
-- recorded is not blocked. Unknown is not a restriction — otherwise every
-- account would be frozen between signup and the onboarding question, including
-- every existing account created before this migration.
create or replace function public.in_blocked_region()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.region_blocked_at is not null
  );
$$;

grant execute on function public.in_blocked_region() to authenticated;


-- ─── Enforcement ────────────────────────────────────────────────────────────
-- RESTRICTIVE policies AND with everything already present, rather than adding
-- an alternative way in. A blocked account keeps its data and can still read;
-- it simply cannot participate. Read access is left alone deliberately — the
-- concern is operating a social service for Mississippi minors, not punishing
-- someone who already has an account.
--
-- Each policy is dropped first so re-running this file doesn't error.

drop policy if exists "Blocked regions cannot post" on public.posts;
create policy "Blocked regions cannot post"
  on public.posts as restrictive for insert
  to authenticated
  with check (not public.in_blocked_region());

drop policy if exists "Blocked regions cannot comment" on public.comments;
create policy "Blocked regions cannot comment"
  on public.comments as restrictive for insert
  to authenticated
  with check (not public.in_blocked_region());

drop policy if exists "Blocked regions cannot message" on public.messages;
create policy "Blocked regions cannot message"
  on public.messages as restrictive for insert
  to authenticated
  with check (not public.in_blocked_region());


-- ─── Operating it ───────────────────────────────────────────────────────────
-- How many accounts are affected:
--
--   select region_code, count(*)
--     from public.profiles
--    where region_blocked_at is not null
--    group by region_code;
--
-- UNBLOCKING a region — when a law is enjoined, or age assurance ships. Both
-- steps are required: removing the list entry stops NEW blocks, and clearing the
-- stamps releases the accounts already caught.
--
--   delete from public.blocked_regions where region_code = 'MS';
--   update public.profiles
--      set region_blocked_at = null
--    where region_code = 'MS';
--
-- Then remove 'MS' from BLOCKED_REGIONS in lib/geoBlock.ts so the app stops
-- offering the explanation.
--
-- ADDING a region:
--
--   insert into public.blocked_regions (region_code, reason)
--   values ('XX', 'why');
--
-- Existing accounts already in that state are NOT retroactively blocked by the
-- insert — set_region only stamps on write. To apply it retroactively:
--
--   update public.profiles
--      set region_blocked_at = now()
--    where region_code = 'XX' and region_blocked_at is null;
