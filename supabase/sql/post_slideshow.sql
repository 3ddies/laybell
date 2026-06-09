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

-- (No new RLS needed: slides is just another column on posts, covered by the
-- existing posts policies.)
