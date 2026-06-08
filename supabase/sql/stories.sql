-- 24-hour Stories — Supabase tables, RLS, and storage bucket
-- Run in the Supabase Dashboard → SQL Editor (the anon key cannot create
-- tables/policies/buckets). Until this is applied, the stories tray stays empty
-- and posting a story silently no-ops, so the app keeps working either way.
--
-- Model: a story is an ephemeral image/video that auto-hides 24h after it's
-- posted. Active (non-expired) stories are readable by any signed-in user so
-- story rings can show on profiles/avatars app-wide; expired ones are hidden.
-- `story_views` powers the unseen/seen ring and the viewer count on your story.

-- ─── stories ────────────────────────────────────────────────────────────────
create table if not exists public.stories (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  media_url        text not null,
  media_type       text not null default 'image' check (media_type in ('image', 'video')),
  thumbnail_url    text,            -- still frame for video stories (optional)
  caption          text,            -- optional overlay text
  aspect_ratio     text,            -- e.g. '9:16' (optional; viewer falls back to cover)
  duration_seconds integer,         -- for video stories
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default (now() + interval '24 hours')
);

create index if not exists stories_user_id_idx    on public.stories(user_id);
create index if not exists stories_expires_at_idx  on public.stories(expires_at);

alter table public.stories enable row level security;

-- A user can always read their own stories (active or expired).
drop policy if exists "Users can view own stories" on public.stories;
create policy "Users can view own stories"
on public.stories for select
using (auth.uid() = user_id);

-- Any signed-in user can read ACTIVE (non-expired) stories, so story rings show
-- on avatars/profiles throughout the app (not only people you follow) and any
-- such story can be opened. Expired stories stay hidden (and own-only via the
-- policy above). If you'd rather keep stories followers-only, replace this with
-- the commented follows-based policy below.
drop policy if exists "Followers can view active stories" on public.stories;
drop policy if exists "Anyone can view active stories" on public.stories;
create policy "Anyone can view active stories"
on public.stories for select
to authenticated
using (expires_at > now());

-- Followers-only alternative (use instead of the policy above if preferred):
-- create policy "Followers can view active stories"
-- on public.stories for select
-- using (
--   expires_at > now()
--   and exists (
--     select 1 from public.follows f
--     where f.follower_id = auth.uid() and f.following_id = stories.user_id
--   )
-- );

-- A user can post stories only as themselves.
drop policy if exists "Users can create own stories" on public.stories;
create policy "Users can create own stories"
on public.stories for insert
with check (auth.uid() = user_id);

-- A user can delete only their own stories.
drop policy if exists "Users can delete own stories" on public.stories;
create policy "Users can delete own stories"
on public.stories for delete
using (auth.uid() = user_id);

-- ─── story_views ─────────────────────────────────────────────────────────────
-- One row per (story, viewer). Drives the unseen-ring styling in the tray and
-- the "seen by N" count shown on your own story.
create table if not exists public.story_views (
  story_id   uuid not null references public.stories(id) on delete cascade,
  viewer_id  uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (story_id, viewer_id)
);

create index if not exists story_views_viewer_idx on public.story_views(viewer_id);

alter table public.story_views enable row level security;

-- A viewer records only their own views.
drop policy if exists "Users can record own story views" on public.story_views;
create policy "Users can record own story views"
on public.story_views for insert
with check (auth.uid() = viewer_id);

-- A viewer can read their own view rows (so the tray knows what's seen).
drop policy if exists "Users can read own story views" on public.story_views;
create policy "Users can read own story views"
on public.story_views for select
using (auth.uid() = viewer_id);

-- A story's author can read who viewed it (viewer count / list).
drop policy if exists "Authors can read views of their stories" on public.story_views;
create policy "Authors can read views of their stories"
on public.story_views for select
using (
  exists (
    select 1 from public.stories s
    where s.id = story_views.story_id
      and s.user_id = auth.uid()
  )
);

-- ─── storage bucket: stories ─────────────────────────────────────────────────
-- Public bucket (like 'posts'/'avatars') so media URLs resolve via getPublicUrl.
-- Uploads land under `<user_id>/<timestamp>.<ext>` (see lib/stories.ts), so the
-- folder-name check restricts writes/deletes to the owner.
insert into storage.buckets (id, name, public)
values ('stories', 'stories', true)
on conflict (id) do nothing;

drop policy if exists "Story media is publicly readable" on storage.objects;
create policy "Story media is publicly readable"
on storage.objects for select
using (bucket_id = 'stories');

drop policy if exists "Users can upload own story media" on storage.objects;
create policy "Users can upload own story media"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'stories'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Users can delete own story media" on storage.objects;
create policy "Users can delete own story media"
on storage.objects for delete to authenticated
using (
  bucket_id = 'stories'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- ─── optional: expired-row cleanup ───────────────────────────────────────────
-- Reads already hide expired stories (RLS + the client's `expires_at > now()`
-- filter), so this is housekeeping only. Run manually, or schedule with pg_cron:
--   select cron.schedule('purge-stories', '0 * * * *', $$select public.purge_expired_stories()$$);
create or replace function public.purge_expired_stories()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.stories where expires_at < now();
$$;
