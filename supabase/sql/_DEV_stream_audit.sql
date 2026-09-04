-- READ ONLY. What Cloudflare Stream SHOULD be storing, per this database.
--
--   npx supabase db query --linked -f supabase/sql/_DEV_stream_audit.sql
--
-- Stream bills on MINUTES OF VIDEO STORED (~$5 per 1,000 minutes/month), not on
-- users or views. The bill is a function of total retained duration and nothing
-- else. Anything Cloudflare stores beyond what this returns is an ORPHAN: an
-- asset no row points at, which nothing will ever remove — the code that deletes
-- Stream assets runs in the APP (lib/postActions.ts), while an account deletion
-- cascades in the DATABASE, where no app code runs.
--
-- One statement on purpose: `supabase db query` returns only the last result.

select
  (select count(*) from public.posts where video_uid is not null)              as posts_with_stream_uid,
  (select count(*) from public.posts where video_uid is not null
     and archived_at is not null)                                              as of_those_archived,
  (select count(*) from public.posts where video_uid is not null
     and coalesce(video_status, '') = 'processing')                            as of_those_stuck_processing,
  (select count(*) from public.posts where type = 'video')                     as video_type_posts,
  (select count(*) from public.posts where type = 'video' and video_uid is null)
                                                                               as video_posts_without_uid,
  -- Duration is what Stream actually charges for. If this is null/0 the DB
  -- cannot answer the cost question and only the Stream API can.
  (select count(*) from public.posts where video_uid is not null
     and coalesce(duration_seconds, 0) = 0)                                    as videos_missing_duration,
  (select round(coalesce(sum(duration_seconds), 0) / 60.0, 1)
     from public.posts where video_uid is not null)                            as known_minutes_stored,
  (select round(coalesce(sum(duration_seconds), 0) / 60.0 * 0.005, 2)
     from public.posts where video_uid is not null)                            as est_usd_month_for_known,
  -- Slideshow slides can carry videos, and those uids are NOT in posts.video_uid,
  -- so post deletion never cleans them up.
  (select count(*) from public.posts p where p.type = 'slideshow'
     and exists (select 1 from jsonb_array_elements(p.slides) s where s->>'type' = 'video'))
                                                                               as slideshows_with_video,
  (select count(*) from public.live_streams)                                   as live_stream_rows,
  (select count(*) from public.posts)                                          as posts_total;
