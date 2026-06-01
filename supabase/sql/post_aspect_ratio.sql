-- Post format / aspect ratio — Supabase
-- Run in the Supabase Dashboard → SQL Editor.
--
-- Stores the chosen display format for image/video posts:
--   images: '1:1' or '9:16'
--   videos: '16:9' or '9:16'
-- The feed and post-detail render media in a container of this ratio (cover).

alter table public.posts
  add column if not exists aspect_ratio text;

-- Existing posts keep aspect_ratio = null and fall back to a sensible default
-- (1:1 for images, 16:9 for videos) in the client.
