-- ============================================================================
-- Video CDN (Cloudflare Stream) — schema. Additive + safe.
--
-- Adds the fields a video post needs to play from Cloudflare Stream (HLS). Old
-- posts have these NULL and keep playing from `media_url` (Supabase Storage), so
-- this is a hybrid rollout with zero migration and no risk to existing content.
--
--   video_uid     — Cloudflare Stream video UID (management + webhook matching)
--   video_status  — 'processing' | 'ready' | 'error' (null for legacy Supabase videos)
--   video_hls_url — the .m3u8 manifest to play (derivable from uid, stored for simplicity)
--   video_poster  — thumbnail URL (Cloudflare auto-generates one)
--
-- Playback rule (app side): coalesce(video_hls_url, media_url) once status = 'ready'.
-- ============================================================================

alter table public.posts add column if not exists video_uid     text;
alter table public.posts add column if not exists video_status  text;
alter table public.posts add column if not exists video_hls_url text;
alter table public.posts add column if not exists video_poster  text;

-- Look up a post by its Stream UID (used by the ready-webhook to flip status).
-- Partial: only the rows that actually use Stream, so the index stays tiny.
create index if not exists posts_video_uid_idx on public.posts (video_uid) where video_uid is not null;

-- ============================================================================
-- UNDO:
--   drop index if exists posts_video_uid_idx;
--   alter table public.posts drop column if exists video_uid;
--   alter table public.posts drop column if exists video_status;
--   alter table public.posts drop column if exists video_hls_url;
--   alter table public.posts drop column if exists video_poster;
-- ============================================================================
