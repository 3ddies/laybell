-- Song "features" — collaborator credits on a music (audio) post. A feature is
-- a Laybell user credited on a song that was collaborated on; the bottom song
-- card flips between the song title and the feature names while it plays, and
-- tapping a feature opens that artist's profile. Non-Laybell collaborators
-- aren't stored here — the creator just adds them to the song title text.
--
-- Denormalized jsonb (matching posts.slides / song_* columns): an array of
-- { id, name } up to 6, so the card can display credits without a join.
--
-- Run manually in the Supabase Dashboard → SQL Editor.

alter table public.posts
  add column if not exists features jsonb not null default '[]'::jsonb;
