-- "Use this song" — attach another creator's audio post to your image/video post
-- or story (like Instagram/TikTok). Run in the Supabase Dashboard → SQL Editor.
-- Until applied, the song picker shows nothing useful and the attribution UI just
-- doesn't render (the columns are read via select('*'), so it's a safe no-op).
--
-- We DENORMALISE the small display fields (title/artist/artist_id) onto the host
-- post/story so the feed, post detail, reel and story viewer can render the
-- attribution from their existing `select('*')` with no extra joins. `song_id`
-- keeps the link to the source audio post (for the 3-dot menu + tap-to-play),
-- and is cleared if that audio post is deleted.

alter table public.posts
  add column if not exists song_id        uuid references public.posts(id) on delete set null,
  add column if not exists song_title     text,
  add column if not exists song_artist    text,
  add column if not exists song_artist_id uuid;

alter table public.stories
  add column if not exists song_id        uuid references public.posts(id) on delete set null,
  add column if not exists song_title     text,
  add column if not exists song_artist    text,
  add column if not exists song_artist_id uuid;
