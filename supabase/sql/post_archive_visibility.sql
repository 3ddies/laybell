-- Archived posts: hidden from everyone but their author — 1.0.3, the owner's call on
-- 2026-09-11: "they should not show anywhere other than the user's archive".
--
-- Until now archiving was filtered in app code alone (post_archive.sql), surface by
-- surface, and the reels feed never had the filter: archived posts played there in
-- every app version. A policy covers every query at once, in the apps already
-- installed as well (there is no OTA), the same way scheduled, taken-down and hidden
-- authors' posts are kept out.
--
-- Author-exempt, because Postgres applies SELECT policies to the rows an UPDATE or
-- DELETE touches: the author must still see their archive, restore a post and delete
-- it. The app still filters the author's OWN lists (feed, reels, profile), which this
-- policy lets them read.
--
-- What it hides from everyone else, by design: an archived song no longer plays on
-- other people's videos that use it, and an archived post drops out of playlists,
-- saves, shares and links — as if deleted, until it is restored. Security-definer
-- functions and the service role are not bound by it; those that hand posts to
-- viewers filter archived_at themselves.
--
-- Safe to re-run.

drop policy if exists "Archived posts hidden from others" on public.posts;
create policy "Archived posts hidden from others"
  on public.posts as restrictive for select
  using (
    -- Cheapest test first: nearly every row is settled by it.
    archived_at is null
    or user_id = auth.uid()
  );

-- ─── Verify ─────────────────────────────────────────────────────────────────
select
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'posts'
      and policyname = 'Archived posts hidden from others' and permissive = 'RESTRICTIVE') as policy_want_1,
  (select count(*) from public.posts where archived_at is not null)                          as archived_posts_now;
