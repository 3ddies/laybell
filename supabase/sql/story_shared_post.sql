-- Post to story (2026-09-26) — repost any post to your 24h story.
--
-- A "post to story" is an ordinary story row whose media is the post's still
-- (cover/thumbnail, used as a backdrop) PLUS a reference to the post it reshares.
-- The viewer renders the post as a tappable card (components/SharedPostCard) over
-- that backdrop, so tapping it opens the original — that's the attribution.
--
-- One nullable column; nothing before this reads or writes it, so it's inert for
-- live app builds until the next release ships.

alter table public.stories
  add column if not exists shared_post_id uuid references public.posts(id) on delete set null;

-- Find a post's story-reshares, and resolve a story's shared post quickly.
create index if not exists stories_shared_post_idx on public.stories (shared_post_id)
  where shared_post_id is not null;

-- NOTE for the app: a shared-post story's media_url points at the ORIGINAL post's
-- image (the posts bucket), NOT a file the story owns. deleteStory() must therefore
-- SKIP storage cleanup when shared_post_id is set, or it would delete the source
-- post's cover. RLS is unchanged: INSERT still requires auth.uid() = user_id.
