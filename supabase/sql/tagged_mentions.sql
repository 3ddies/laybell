-- "Tagged" feature: @mentions + song-usage notifications.
--
-- Run this in the Supabase dashboard SQL editor. Safe to re-run.

-- 1) Mentions: a row per (@mentioned user) in a post caption or a comment body.
--    Written by the author (actor); read by the mentioned user.
create table if not exists public.mentions (
  id                uuid primary key default gen_random_uuid(),
  mentioned_user_id uuid not null references auth.users(id) on delete cascade,
  actor_id          uuid not null references auth.users(id) on delete cascade,
  post_id           uuid references public.posts(id) on delete cascade,
  comment_id        uuid references public.comments(id) on delete cascade,
  created_at        timestamptz not null default now()
);

alter table public.mentions enable row level security;

-- You can read mentions OF you (for the Tagged screen) or ones you wrote.
drop policy if exists "mentions_select" on public.mentions;
create policy "mentions_select" on public.mentions
  for select using (auth.uid() = mentioned_user_id or auth.uid() = actor_id);

-- You can only create mentions as yourself (the author).
drop policy if exists "mentions_insert" on public.mentions;
create policy "mentions_insert" on public.mentions
  for insert with check (auth.uid() = actor_id);

create index if not exists mentions_mentioned_idx on public.mentions(mentioned_user_id, created_at desc);

-- 2) Allow the new notification types. The notifications.type CHECK constraint
--    (if one exists) only permitted like/comment/follow/message; recreate it with
--    the new mention + song-usage types so those inserts don't fail.
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('like','comment','follow','message','mention','song_used','song_story'));

-- 3) Let the original artist SEE any post/story that used their song (for the
--    Tagged screen) — even a followers-only one from someone they don't follow.
--    These are additive (RLS select policies are OR'd) and only ever match rows
--    where the querying user IS the song's artist.
drop policy if exists "posts_song_artist_select" on public.posts;
create policy "posts_song_artist_select" on public.posts
  for select using (auth.uid() = song_artist_id);

drop policy if exists "stories_song_artist_select" on public.stories;
create policy "stories_song_artist_select" on public.stories
  for select using (auth.uid() = song_artist_id);

create index if not exists posts_song_artist_idx on public.posts(song_artist_id);
create index if not exists stories_song_artist_idx on public.stories(song_artist_id);
