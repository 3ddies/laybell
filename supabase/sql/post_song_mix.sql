-- A post's sound — set in the 1.0.3 video studio (components/VideoStudio).
--
--   song_start_sec  where the attached song starts, in seconds
--   song_volume     the song's level, 0..1
--   video_volume    the video's own sound, 0..1
--
-- All three stay NULL for a post published without the editor, and such a post
-- plays exactly as every song post always has: the song from its first second at
-- full volume, the video silent. Apps older than 1.0.3 never read these columns
-- and play every post that way, so there is nothing for them to get wrong.
--
-- Additive and nullable — safe to run at any time. If PostgREST has not seen the
-- columns yet, the upload queue drops them and inserts again
-- (contexts/UploadQueueContext.tsx), so no post is lost to deploy order.

alter table public.posts add column if not exists song_start_sec real;
alter table public.posts add column if not exists song_volume real;
alter table public.posts add column if not exists video_volume real;

alter table public.posts drop constraint if exists posts_song_mix_range;
alter table public.posts add constraint posts_song_mix_range check (
  (song_start_sec is null or song_start_sec >= 0)
  and (song_volume is null or (song_volume >= 0 and song_volume <= 1))
  and (video_volume is null or (video_volume >= 0 and video_volume <= 1))
);

notify pgrst, 'reload schema';

-- Verify (expect three rows, all real):
--   select column_name, data_type from information_schema.columns
--    where table_schema = 'public' and table_name = 'posts'
--      and column_name in ('song_start_sec', 'song_volume', 'video_volume');
