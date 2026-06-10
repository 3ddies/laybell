-- Story text: a story can have BOTH
--   • a draggable/resizable TEXT STICKER placed anywhere on the media
--       sticker_text  text
--       sticker_style jsonb = { x, y, scale, rotation }   (x,y = center, 0..1 of frame)
--   • a plain bottom CAPTION (stories.caption, unchanged) shown at the bottom.
--
-- (Supersedes the earlier single caption_style approach in story_caption_style.sql;
--  that column is now unused/deprecated but harmless if it already exists.)
--
-- Run this in the Supabase dashboard SQL editor. Safe to re-run.

alter table public.stories add column if not exists sticker_text  text;
alter table public.stories add column if not exists sticker_style jsonb;
