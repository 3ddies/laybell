-- Deduplicated stream counting — Supabase
-- Run in the Supabase Dashboard → SQL Editor.
--
-- Policy (enforced client-side in contexts/AudioContext.tsx, logged here):
--   * A user's FIRST counted stream of a song lands once they reach 10%.
--   * Every listen after that must reach 100% to count again.
-- Each counted stream is one row in `streams`; a trigger bumps posts.stream_count.
-- This supersedes the old increment_stream_count() RPC (which may be left in place
-- unused, or dropped: drop function if exists public.increment_stream_count(uuid);).

alter table public.posts
  add column if not exists stream_count integer not null default 0;

create table if not exists public.streams (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  post_id uuid not null references public.posts(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists streams_user_post_idx on public.streams (user_id, post_id);

alter table public.streams enable row level security;

create policy "Users insert own streams" on public.streams
  for insert with check (auth.uid() = user_id);

create policy "Users read own streams" on public.streams
  for select using (auth.uid() = user_id);

-- Bump the public counter on each counted stream.
create or replace function public.bump_stream_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.posts set stream_count = stream_count + 1 where id = new.post_id;
  return null;
end;
$$;

drop trigger if exists trg_bump_stream_count on public.streams;
create trigger trg_bump_stream_count
after insert on public.streams
for each row execute function public.bump_stream_count();
