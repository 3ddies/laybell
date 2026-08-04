-- Music videos: credit the song WITHOUT ever playing it.
--
-- The existing "use this song" feature (post_song.sql) assumes the attached
-- song REPLACES the host video's audio — the video is muted and the song plays
-- over it. That is exactly wrong for a music video, where the song is already
-- in the video's own soundtrack: attaching it that way plays the track twice,
-- out of sync with itself.
--
-- This flag marks an attachment as credit-and-link only. The card still renders
-- and still points at the song, so viewers can go stream it, but the audio
-- engine never touches it and the video keeps its own sound.
--
-- Deliberately a flag on the EXISTING attachment rather than a second set of
-- song_* columns: it is the same relationship (this post credits that song),
-- only the playback contract differs. Every read site already pulls song_* via
-- select('*'), so this rides along with no query changes.
--
-- Safe no-op until applied: absent column reads as undefined, which the app
-- treats as "plays" — i.e. exactly today's behaviour.
--
-- Run in the Supabase Dashboard → SQL Editor, or:
--   npx supabase db query --linked -f supabase/sql/post_song_link_only.sql

alter table public.posts
  add column if not exists song_link_only boolean not null default false;

comment on column public.posts.song_link_only is
  'True when the attached song_id is a CREDIT ONLY (music video): the card links '
  'to the song but its audio is never played, and the host video keeps its own '
  'soundtrack. False/null = the legacy behaviour, where the song plays and the '
  'host video is muted.';

-- Verify: should list the new column with default false.
select column_name, data_type, column_default, is_nullable
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'posts'
   and column_name = 'song_link_only';
