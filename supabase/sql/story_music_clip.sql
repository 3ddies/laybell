-- Story music clip (1.0.8): let the poster choose WHERE in the attached song
-- playback starts, and HOW LONG it plays (up to 25s). The start drives the song's
-- offset in the viewer (reusing the existing ambient-mix startSec path); the clip
-- length also becomes the IMAGE story's on-screen duration, so the chosen part of
-- the song plays out before the story advances.
--
-- Additive + nullable: older builds that never write these keep working untouched,
-- and a story without music (or one posted before this) leaves both null — the
-- viewer then falls back to its fixed 10s image duration and starts the song at 0.
-- No RLS/grant change: the columns inherit the stories table's existing policies,
-- and the authenticated role already inserts/selects song_* columns on this table.

alter table public.stories
  add column if not exists song_start_sec real,
  add column if not exists song_clip_sec  real;

comment on column public.stories.song_start_sec is
  'Seconds into the attached song where it starts playing in the viewer (null/0 = from the top).';
comment on column public.stories.song_clip_sec is
  'Chosen clip length in seconds (clamped 5..25 by the client); also the image story''s on-screen duration. Null = default 10s.';
