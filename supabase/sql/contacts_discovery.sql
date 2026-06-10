-- Contact discovery (privacy-preserving) — Supabase table + RPC
-- Run in the Supabase Dashboard → SQL Editor (the anon key cannot alter schema).
-- Until applied, the contacts toggle reads/writes nothing and suggestions fall back
-- to genre/affinity, so the app keeps working either way.
--
-- HOW IT WORKS
--   • Each user's own phone/email are stored ONLY as salted SHA-256 hashes (the
--     client hashes them; plaintext never leaves the device for these identifiers).
--   • Hashes live in `user_identifiers`, a table with NO select policy — clients can
--     write their own row but can never read the table directly (no bulk dump).
--   • Discovery goes through match_contacts(): the client hashes the phone numbers /
--     emails from the device address book and asks "which of these are on Laybell?".
--     The function returns only the matching user_ids.
--
-- NOTE: hash-based contact discovery is best-effort, not brute-force-proof (phone
-- numbers are low entropy). The opaque table + RPC raise the cost vs. exposing
-- hashes on the public profiles row, which is the appropriate trade-off here.

alter table public.profiles
  add column if not exists contacts_enabled boolean default false;

create table if not exists public.user_identifiers (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email_hash text,
  phone_hash text,
  updated_at timestamptz default now()
);

alter table public.user_identifiers enable row level security;

create index if not exists idx_user_ident_email on public.user_identifiers (email_hash);
create index if not exists idx_user_ident_phone on public.user_identifiers (phone_hash);

-- Owner may insert/update their own row. Deliberately NO select policy → the table
-- is opaque to clients; reads happen only through the SECURITY DEFINER function below.
drop policy if exists "own identifiers insert" on public.user_identifiers;
create policy "own identifiers insert"
on public.user_identifiers for insert
with check (auth.uid() = user_id);

drop policy if exists "own identifiers update" on public.user_identifiers;
create policy "own identifiers update"
on public.user_identifiers for update
using (auth.uid() = user_id);

-- Returns the user_ids whose hashed identifier is in the caller's contact-hash set.
-- Excludes the caller. SECURITY DEFINER so it can read the opaque table.
create or replace function public.match_contacts(hashes text[])
returns table (user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select ui.user_id
  from public.user_identifiers ui
  where (ui.email_hash = any(hashes) or ui.phone_hash = any(hashes))
    and ui.user_id <> auth.uid()
$$;

grant execute on function public.match_contacts(text[]) to authenticated;
