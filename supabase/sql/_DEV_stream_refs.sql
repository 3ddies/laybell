-- READ ONLY. Every place a Cloudflare Stream URL is recorded, so a sweep that
-- deletes "unreferenced" assets can be checked against reality BEFORE it runs.
--
--   npx supabase db query --linked -f supabase/sql/_DEV_stream_refs.sql
--
-- supabase/functions/stream-sweep only looks at posts.video_uid,
-- posts.media_url and ad_creatives.media_url. Any Stream uid living anywhere
-- else is invisible to it and would be deleted as an orphan — which for a
-- slideshow's video slide means destroying a real post's media.

select
  (select count(*) from public.posts where video_uid is not null)                 as ref_posts_video_uid,
  (select count(*) from public.posts where media_url ilike '%cloudflarestream.com%')
                                                                                  as ref_posts_media_url,
  -- The gap: videos inside a slideshow live in slides[].url, not media_url.
  (select count(*) from public.posts p
     where p.type = 'slideshow'
       and exists (select 1 from jsonb_array_elements(p.slides) s
                    where s->>'url' ilike '%cloudflarestream.com%'))              as ref_slides_STREAM_urls,
  -- ...and their thumbnails/posters.
  (select count(*) from public.posts p
     where p.type = 'slideshow'
       and exists (select 1 from jsonb_array_elements(p.slides) s
                    where s->>'thumbnail_url' ilike '%cloudflarestream.com%'))    as ref_slides_thumb_urls,
  (select count(*) from public.ad_creatives where media_url ilike '%cloudflarestream.com%')
                                                                                  as ref_ad_creatives,
  -- Sample the actual slide URLs so the uids are visible, not inferred.
  (select jsonb_agg(s->>'url')
     from public.posts p, jsonb_array_elements(p.slides) s
    where p.type = 'slideshow' and s->>'type' = 'video')                          as slideshow_video_urls;
