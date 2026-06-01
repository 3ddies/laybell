-- Album/cover art for audio posts — Supabase
-- Run in the Supabase Dashboard → SQL Editor.
--
-- Optional cover image uploaded alongside an audio post; shown to the left of the
-- track title/artist wherever tracks are listed.

alter table public.posts
  add column if not exists cover_url text;
