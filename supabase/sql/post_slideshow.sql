-- Slideshow (carousel) posts: a compilation of up to 8 images and/or videos.
--
-- Stored on the existing posts table as a single jsonb array so it rides along
-- with `select('*')` everywhere (no joins, no per-query changes). A slideshow row
-- has type = 'slideshow' and:
--   slides       jsonb  -- ordered array, each: { type: 'image'|'video', url, thumbnail_url, aspect_ratio }
-- The row's existing media_url / thumbnail_url / aspect_ratio are also set from
-- the FIRST slide, so every thumbnail surface (profile grids, archive, explore,
-- shared-in-chat) shows the cover with no extra work — we just badge it as multi.
--
-- Run this in the Supabase dashboard SQL editor. Safe to re-run.

alter table posts add column if not exists slides jsonb;

-- Allow the new 'slideshow' type. The posts.type CHECK constraint
-- (posts_type_check) only permitted image/video/audio/podcast/audiobook, so
-- inserting a slideshow failed with: new row for relation "posts" violates
-- check constraint "posts_type_check". Recreate it with 'slideshow' added.
alter table posts drop constraint if exists posts_type_check;
alter table posts add constraint posts_type_check
  check (type in ('image', 'video', 'audio', 'podcast', 'audiobook', 'slideshow'));

-- (No new RLS needed: slides is just another column on posts, covered by the
-- existing posts policies.)
