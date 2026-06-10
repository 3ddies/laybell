-- Story text stickers (multiple). A story can have any number of draggable text
-- stickers placed anywhere on the media, PLUS the plain bottom `caption`.
--   stickers jsonb = [ { text, x, y, scale, rotation }, … ]
--     x, y     — center of the text, 0..1 of the frame (0.5,0.5 = centered)
--     scale    — font scale multiplier; rotation — degrees
--
-- (Supersedes the single sticker_text/sticker_style and caption_style columns from
--  the earlier attempts — those are now unused but harmless if already present.)
--
-- Run this in the Supabase dashboard SQL editor. Safe to re-run.

alter table public.stories add column if not exists stickers jsonb;
