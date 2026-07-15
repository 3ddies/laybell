-- ============================================================================
-- Stream backfill — schema. Additive + safe. RUN BEFORE deploying the
-- stream-backfill edge function.
--
-- Migrates OLD video posts (raw MP4s in Supabase Storage) onto Cloudflare
-- Stream so they play as adaptive HLS like new posts do. The actual work is
-- done by supabase/functions/stream-backfill (driven by
-- scripts/stream-backfill.mjs); this file only adds:
--
--   legacy_media_url — the original Supabase Storage MP4 URL, captured at the
--                      moment a copy is requested. Kept as a permanent
--                      fallback/audit trail (and so post-deletion can still
--                      clean up the Storage object after media_url becomes the
--                      HLS manifest — see lib/storageCleanup.ts).
--
-- All state lives in the posts row itself, which is what makes the backfill
-- resumable and idempotent:
--
--   not started    type='video', video_uid IS NULL, video_status IS NULL,
--                  media_url NOT a cloudflarestream.com URL
--   copy requested video_uid set, video_status='processing',
--                  legacy_media_url set — media_url is NOT touched yet, so
--                  playback keeps working off the MP4 while Cloudflare encodes
--   done           video_status='ready', media_url = HLS manifest
--                  (thumbnail_url is never touched)
--   failed         video_status='error' — media_url still the MP4, playback
--                  unaffected; retry recipe below
-- ============================================================================

alter table public.posts add column if not exists legacy_media_url text;

-- Candidate scan: legacy video posts not yet sent to Stream. Partial, so it
-- shrinks to nothing as the backfill completes.
create index if not exists posts_stream_backfill_todo_idx
  on public.posts (created_at desc)
  where type = 'video' and video_uid is null and video_status is null;

-- In-flight scan: rows waiting on Cloudflare encoding (also matches app-path
-- posts stuck in 'processing' because the poster closed the app mid-poll —
-- the backfill sweep heals those for free).
create index if not exists posts_video_processing_idx
  on public.posts (created_at)
  where video_status = 'processing';

-- ============================================================================
-- MONITORING (run any time):
--
--   -- How many legacy MP4 posts are left to enqueue?
--   select count(*) from public.posts
--    where type = 'video' and video_uid is null and video_status is null
--      and media_url is not null and media_url not ilike '%cloudflarestream.com%';
--
--   -- Backfill state breakdown:
--   select video_status, count(*) from public.posts
--    where type = 'video' group by video_status order by 2 desc;
--
--   -- Failures (source MP4 missing/corrupt, encode error):
--   select id, created_at, legacy_media_url from public.posts
--    where type = 'video' and video_status = 'error' order by created_at desc;
--
-- RETRY a failed row (clears the claim so the next backfill round retries it):
--
--   update public.posts
--      set video_uid = null, video_status = null
--    where type = 'video' and video_status = 'error' and video_uid is null;
--
--   -- (rows that errored AFTER a copy was created keep their video_uid for
--   --  diagnosis; to retry those too, also null the uid — the orphaned
--   --  Cloudflare asset can be deleted from the Stream dashboard.)
--
-- UNDO (schema only — flipped posts keep playing from their HLS media_url):
--   drop index if exists posts_stream_backfill_todo_idx;
--   drop index if exists posts_video_processing_idx;
--   alter table public.posts drop column if exists legacy_media_url;
-- ============================================================================
