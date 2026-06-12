-- Hidden profiles + soft account deletion — run manually in the Supabase SQL editor.
--
-- Model (user-confirmed):
--  * hidden = true → the account is invisible to OTHERS: profile page blocked,
--    and the RESTRICTIVE policies below remove their posts/stories/playlists
--    from every surface server-side (feeds, search, grids, charts) while the
--    owner still sees their own content. The hidden user may browse and
--    listen, but the app blocks them from DMing and commenting.
--  * Deleting an account first offers "hide for 3 months instead". Accepting
--    sets hidden + delete_requested_at. Deletion is MANUAL (no cron): an
--    account is eligible only after 3 months of INACTIVITY — any sign-in
--    bumps last_seen_at and pushes deletion out; unhiding cancels entirely.
--  * Declining the offer marks delete_immediately for manual removal ASAP.

alter table public.profiles add column if not exists hidden boolean not null default false;
alter table public.profiles add column if not exists delete_requested_at timestamptz;
alter table public.profiles add column if not exists delete_immediately boolean not null default false;
alter table public.profiles add column if not exists last_seen_at timestamptz default now();

-- RESTRICTIVE policies AND with the existing permissive ones — one statement
-- per table hides a hidden author's content app-wide without touching any of
-- the existing policies. Owners always see their own rows.
drop policy if exists "Hidden authors' posts are invisible" on public.posts;
create policy "Hidden authors' posts are invisible"
  on public.posts as restrictive for select
  using (
    user_id = auth.uid()
    or not exists (select 1 from public.profiles p where p.id = user_id and p.hidden)
  );

drop policy if exists "Hidden authors' stories are invisible" on public.stories;
create policy "Hidden authors' stories are invisible"
  on public.stories as restrictive for select
  using (
    user_id = auth.uid()
    or not exists (select 1 from public.profiles p where p.id = user_id and p.hidden)
  );

drop policy if exists "Hidden authors' playlists are invisible" on public.playlists;
create policy "Hidden authors' playlists are invisible"
  on public.playlists as restrictive for select
  using (
    user_id = auth.uid()
    or not exists (select 1 from public.profiles p where p.id = user_id and p.hidden)
  );

-- ── Manual deletion (run from the dashboard when you want to clean up) ───────
-- Accounts whose owners asked for deletion and have been gone 3+ months:
--   select id, username, delete_requested_at, last_seen_at
--   from public.profiles
--   where hidden and delete_requested_at is not null and not delete_immediately
--     and coalesce(last_seen_at, delete_requested_at) < now() - interval '3 months';
--
-- Accounts that declined the grace period (delete ASAP):
--   select id, username, delete_requested_at
--   from public.profiles
--   where delete_immediately;
--
-- To permanently delete one (cascades wipe profile, posts, stories, etc.):
--   delete from auth.users where id = '<user-id>';
