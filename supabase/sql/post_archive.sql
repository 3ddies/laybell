-- Post archiving — Supabase column
-- Run in the Supabase Dashboard → SQL Editor (the anon key cannot alter tables).
-- Until this is applied, the Archive screen stays empty and the "Archive post"
-- action shows a friendly error, so the app keeps working either way.
--
-- Model: archiving hides a post from your profile, the feed and explore WITHOUT
-- deleting it. `archived_at` is null for a live post and holds the archive time
-- for an archived one. The owner can restore it (set back to null) or delete it
-- permanently from the Archive screen.
--
-- Visibility: archived posts are filtered out client-side everywhere they would
-- otherwise show (own/public profile grids, home feed, explore). The owner still
-- reads them (RLS already lets a user read their own posts) so the Archive screen
-- can list them. Deleting a post still removes the row entirely, so deleted
-- content never appears in the archive.

alter table public.posts
  add column if not exists archived_at timestamptz;

-- Partial index — only archived rows are indexed, keeping it tiny. Powers the
-- Archive screen's "my archived posts, newest first" query.
create index if not exists posts_archived_at_idx
  on public.posts (user_id, archived_at)
  where archived_at is not null;
