-- Per-post creator controls set at posting time (both default ON, so existing
-- posts and anyone who doesn't touch the toggles keep the current behaviour):
--   • downloadable — already exists (audio offline pin). No change here.
--   • allow_gifs   — whether other users may "Make GIF" from this video post.
-- Run manually in the Supabase SQL editor. Until applied, allow_gifs reads as
-- NULL which the app treats as true (opt-out only), so nothing breaks pre-migration.

alter table public.posts add column if not exists allow_gifs boolean not null default true;
