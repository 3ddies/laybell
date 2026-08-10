-- ───────────────────────────────────────────────────────────────────────────
-- App-sharing badge — make it count PEOPLE, not taps.
--
-- THE HOLE THIS CLOSES: record_app_share() blindly did
--   update profiles set app_shares = app_shares + 1
-- with no idea who was shared to. Opening the share sheet and sending the link
-- to yourself fifteen times earned Gold Advocate. The badge measured
-- persistence, not advocacy.
--
-- HOW IT WORKS NOW: an invite is recorded against a SALTED HASH of the contact
-- (phone or email), hashed on the device exactly like contact discovery — the
-- plaintext number never leaves the phone. The primary key is
-- (user_id, contact_hash), so inviting the same person twice is a no-op and the
-- badge counter is DERIVED from the row count rather than incremented. Sharing
-- to the same person repeatedly now moves nothing.
--
-- Idempotent; safe to re-run.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.app_share_invites (
  user_id      uuid not null references auth.users(id) on delete cascade,
  -- Salted SHA-256 of the normalized phone/email (lib/hash.ts). Never plaintext.
  contact_hash text not null,
  created_at   timestamptz not null default now(),
  primary key (user_id, contact_hash)
);

alter table public.app_share_invites enable row level security;

-- The owner may READ their own rows: the invite screen needs them to show which
-- contacts are already ticked off. They are hashes of that user's own address
-- book, which the device can recompute anyway, so this leaks nothing new.
drop policy if exists "own invites read" on public.app_share_invites;
create policy "own invites read"
on public.app_share_invites for select using (auth.uid() = user_id);

-- Deliberately NO insert/update/delete policy: writes go through the RPC below,
-- so the badge counter can never be set by a crafted client. A user who could
-- insert rows directly could still not inflate the count past their real
-- contacts, but they could invent hashes — the RPC keeps one door.

create index if not exists app_share_invites_user_idx
  on public.app_share_invites (user_id, created_at desc);

-- ─── record_app_share_contacts ───────────────────────────────────────────────
-- Records one invite per NEW contact hash and returns the caller's new lifetime
-- total. The counter is recomputed from the table, never incremented, so it can
-- only ever equal the number of distinct people invited.
create or replace function public.record_app_share_contacts(p_hashes text[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_total integer;
begin
  if v_uid is null then return 0; end if;

  -- Cap one call so a runaway client can't write a whole address book at once.
  insert into public.app_share_invites (user_id, contact_hash)
  select v_uid, h
  from unnest(coalesce(p_hashes, '{}')) as h
  where h is not null and length(h) between 16 and 128
  limit 200
  on conflict (user_id, contact_hash) do nothing;

  select count(*) into v_total
  from public.app_share_invites where user_id = v_uid;

  update public.profiles set app_shares = v_total where id = v_uid;
  return v_total;
end;
$$;

revoke execute on function public.record_app_share_contacts(text[]) from public, anon;
grant execute on function public.record_app_share_contacts(text[]) to authenticated;

-- ─── The old counter is retired ──────────────────────────────────────────────
-- Kept as a no-op rather than dropped: an older client build still calls it, and
-- a missing function would surface as an error toast. It simply no longer moves
-- the badge. New progress comes only from record_app_share_contacts.
create or replace function public.record_app_share()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Intentionally does nothing. See app_share_invites.sql.
  return;
end;
$$;

-- Re-derive every existing counter from real invites, so no account keeps a
-- total it earned by tapping share at itself. (Pre-launch this only touches
-- test accounts.)
update public.profiles p
   set app_shares = coalesce(
     (select count(*) from public.app_share_invites i where i.user_id = p.id), 0)
 where coalesce(p.app_shares, 0) <> coalesce(
     (select count(*) from public.app_share_invites i where i.user_id = p.id), 0);
