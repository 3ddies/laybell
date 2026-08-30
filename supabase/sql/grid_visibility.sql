-- Hiding a song or video from the profile GRID.
--
-- Run manually in the Supabase SQL editor. ADDITIVE: one nullable-with-default
-- column. The shipped 1.0.0 build never selects it and never sets it, so it is
-- invisible to every client that does not know about it.
--
-- NOT archiving, and the distinction is the whole feature. An archived post
-- leaves the profile entirely and stops being public. This one stays public,
-- keeps its link, keeps playing, keeps its place on the Music or Videos tab —
-- it just stops taking a square in the Posts grid. A musician whose grid is
-- three photos and nine song cards can make it look like a photo grid again
-- without hiding the songs from anyone.
--
-- WHY ONLY SONGS AND VIDEOS. The grid has to still have something in it, and
-- pictures are what a grid is FOR. Letting photos be hidden this way would
-- produce empty grids and a second, quieter kind of "archived" that behaves
-- differently — so a photo's only exit is archiving, which is honest about
-- taking it off the profile. The client enforces the same rule twice: the menu
-- item is offered only on audio and video, and only when the owner still has a
-- picture to show instead.
--
-- No RLS work needed: posts' existing owner-update policy already governs who
-- can set this, and the column is readable wherever the post is.

alter table public.posts
  add column if not exists hide_from_grid boolean not null default false;

-- Verify:
--   select column_name, data_type, column_default
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'posts'
--      and column_name = 'hide_from_grid';
--
-- How many are hidden right now (expect 0 immediately after running):
--   select count(*) from public.posts where hide_from_grid;
