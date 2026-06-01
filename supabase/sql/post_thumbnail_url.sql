-- Video thumbnail URL — Supabase
-- Run in the Supabase Dashboard → SQL Editor.
--
-- Stores a generated still frame for video posts, uploaded to the same `posts`
-- storage bucket at composition time. Grids (profile, public profile, private
-- posts, explore) display this image instead of a generic placeholder.

alter table public.posts
  add column if not exists thumbnail_url text;

-- Existing videos keep thumbnail_url = null and fall back to the placeholder
-- icon in the grid.
