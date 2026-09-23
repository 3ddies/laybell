-- Explore's video previews, without a bill that grows with users — 1.0.4.
--
--   npx supabase db query --linked -f supabase/sql/post_video_previews.sql
--
-- The owner liked 1.0.2's real video previews better than the moving stills that
-- replaced them, but not at Cloudflare's price: Stream bills every second it
-- delivers, including buffering, so a looping preview re-bills on every pass
-- (~$1,500/month at 10k users — docs/POST_LAUNCH_BACKLOG.md §11).
--
-- This column holds a different thing: a ~5 second, muted, small MP4 that the
-- POSTER'S PHONE cuts from its own copy of the video at post time
-- (modules/laybell-video-export), uploaded next to the poster in the `posts`
-- bucket. It never touches Cloudflare Stream, and expo-video caches it on the
-- phone (`useCaching`), so only a preview someone has never seen costs anything
-- at all — replays, scroll-backs and return visits are free.
--
-- Nullable, and nothing before 1.0.4 reads it. Posts from older apps, and posts
-- whose export failed, simply keep the moving stills (components/PreviewStills).
-- The file lives in the same posts/<user id>/ folder as the rest of the post's
-- media, so post deletion (lib/storageCleanup.collectPostMediaUrls) and account
-- deletion (purge_profile_storage) already remove it.

alter table public.posts add column if not exists preview_url text;

comment on column public.posts.preview_url is
  '~5s muted small MP4 cut on the poster''s device, looped as the Explore tile preview. Cached client-side; never served from Cloudflare Stream. 1.0.4.';

-- Verify.
select count(*) filter (where column_name = 'preview_url') as preview_url_must_be_1
from information_schema.columns
where table_schema = 'public' and table_name = 'posts';
