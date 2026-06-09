-- User blocking — Supabase table, RLS, indexes
-- Run in the Supabase Dashboard → SQL Editor (the anon key cannot create tables
-- or policies). Until this is applied, the block button shows a friendly error
-- and the Blocked list stays empty, so the app keeps working either way.
--
-- Model: one row per (blocker, blocked). A user manages only their OWN blocks.
-- The app filters a blocked user's posts out of your home feed and explore
-- (client-side) and offers a Blocked list in Settings to review / unblock.
-- NOTE: this is a one-directional, client-side hide — the blocked user is not
-- prevented at the database level from seeing the blocker's public content. A
-- future pass could enforce mutual invisibility via RLS using this table.

create table if not exists public.blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create index if not exists blocks_blocker_idx on public.blocks(blocker_id);

alter table public.blocks enable row level security;

-- A user can read only their own block rows (to render the Blocked list and to
-- filter content client-side).
drop policy if exists "Users can read own blocks" on public.blocks;
create policy "Users can read own blocks"
on public.blocks for select
using (auth.uid() = blocker_id);

-- A user can block only as themselves.
drop policy if exists "Users can create own blocks" on public.blocks;
create policy "Users can create own blocks"
on public.blocks for insert
with check (auth.uid() = blocker_id);

-- A user can unblock only their own blocks.
drop policy if exists "Users can delete own blocks" on public.blocks;
create policy "Users can delete own blocks"
on public.blocks for delete
using (auth.uid() = blocker_id);
