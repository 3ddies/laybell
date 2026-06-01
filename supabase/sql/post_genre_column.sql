-- Genre as a first-class column on posts (replaces the post_tags approach for
-- genre browsing). Run in the Supabase Dashboard → SQL Editor.
--
-- Posts already insert/read under existing RLS, so no extra policies are needed —
-- the composer writes posts.genre on create, and Explore filters posts.genre.

alter table public.posts
  add column if not exists genre text;

create index if not exists posts_genre_idx on public.posts (genre);

-- Optional: if you previously created any rows in post_tags, you can ignore them;
-- genre browsing no longer uses that table.
