-- Laybell GIF library — each user's own collection of GIFs: ones they SAVED
-- (e.g. from the Giphy picker) and ones they CREATED (Make GIF). Backs the
-- "My GIFs" tab in the GIF picker. Run manually in the Supabase SQL editor.
-- Until applied, the library is empty and the app keeps working (search still works).

create table if not exists public.user_gifs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  url        text not null,
  w          integer,
  h          integer,
  kind       text not null default 'saved',   -- 'saved' | 'created'
  source_post_id uuid,                         -- for 'created' GIFs: the original Laybell video post
  created_at timestamptz not null default now()
);

-- Backfill for anyone who ran an earlier version of this file.
alter table public.user_gifs add column if not exists source_post_id uuid;

-- One row per (user, url): re-saving the same GIF is a no-op upsert.
create unique index if not exists user_gifs_user_url_idx on public.user_gifs (user_id, url);
create index if not exists user_gifs_user_idx on public.user_gifs (user_id, created_at desc);

alter table public.user_gifs enable row level security;

-- A user fully manages their own library (and only their own).
drop policy if exists "Users manage their own gifs" on public.user_gifs;
create policy "Users manage their own gifs"
  on public.user_gifs for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
