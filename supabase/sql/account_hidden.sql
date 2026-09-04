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

-- ── Added 2026-09-04: the surfaces the first pass missed ────────────────────
--
-- The three policies above cover posts, stories and playlists. They were the
-- whole of a hidden author's public content when this file was written; they
-- are not any more. Hiding an account left its STOREFRONT up — an active
-- listing with a seller whose profile is blocked, so a buyer could open a
-- product and hit a dead end on the person selling it. Albums shipped in 1.0.1
-- and were never covered at all.
--
-- shop_listings already had two restrictive policies, which is what made this
-- easy to miss: they are about copyright removal and moderation takedowns, and
-- neither has anything to do with hidden authors.
--
-- The whole file is idempotent — re-run it.

drop policy if exists "Hidden sellers' listings are invisible" on public.shop_listings;
create policy "Hidden sellers' listings are invisible"
  on public.shop_listings as restrictive for select
  using (
    user_id = auth.uid()
    or not exists (select 1 from public.profiles p where p.id = user_id and p.hidden)
  );

-- An album is a playlist by another name — same shape, same reasoning.
drop policy if exists "Hidden authors' albums are invisible" on public.albums;
create policy "Hidden authors' albums are invisible"
  on public.albums as restrictive for select
  using (
    user_id = auth.uid()
    or not exists (select 1 from public.profiles p where p.id = user_id and p.hidden)
  );

-- album_tracks has no user_id of its own, so ownership is read through the
-- album. Hiding the album is most of the protection — you cannot discover the
-- id — but a shared link carries one, and these rows hold a per-track title
-- override. An orphaned track (no album row) resolves to false and stays hidden,
-- which is the right way for this to fail.
drop policy if exists "Hidden authors' album tracks are invisible" on public.album_tracks;
create policy "Hidden authors' album tracks are invisible"
  on public.album_tracks as restrictive for select
  using (
    exists (
      select 1 from public.albums a
       where a.id = album_id
         and (
           a.user_id = auth.uid()
           or not exists (select 1 from public.profiles p where p.id = a.user_id and p.hidden)
         )
    )
  );

-- A hidden account must not appear on the Live tab. The app does not currently
-- stop a hidden user from broadcasting, so this is the layer that holds.
drop policy if exists "Hidden broadcasters' streams are invisible" on public.live_streams;
create policy "Hidden broadcasters' streams are invisible"
  on public.live_streams as restrictive for select
  using (
    user_id = auth.uid()
    or not exists (select 1 from public.profiles p where p.id = user_id and p.hidden)
  );

-- DELIBERATELY NOT COVERED: communities.
--
-- A community is shared infrastructure with its own members and moderators, not
-- personal content. Hiding one because the person who created it went private
-- would take it away from everyone else in it. Written down so a later audit
-- reads this as a decision rather than the same oversight twice.

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
