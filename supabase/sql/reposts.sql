-- Reposts — Supabase table + RLS
-- Run in the Supabase Dashboard → SQL Editor (anon key cannot create tables).
--
-- Backs the global "Repost" action (lib/reposts.ts) and the public Reposts tab
-- on every profile. Until this is applied, repost actions silently no-op and the
-- Reposts tab is empty, so the app keeps working either way.

create table if not exists public.reposts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  post_id     uuid not null references public.posts(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (user_id, post_id)
);

create index if not exists reposts_user_id_idx on public.reposts(user_id);
create index if not exists reposts_post_id_idx on public.reposts(post_id);

alter table public.reposts enable row level security;

-- Reposts are public — anyone can see what a user has reposted (drives the
-- public Reposts tab on profiles).
create policy "Reposts are viewable by everyone"
on public.reposts for select
using (true);

-- A user can repost only as themselves.
create policy "Users can create own reposts"
on public.reposts for insert
with check (auth.uid() = user_id);

-- A user can remove only their own reposts.
create policy "Users can delete own reposts"
on public.reposts for delete
using (auth.uid() = user_id);
