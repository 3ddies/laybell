-- Premium perk, REPLACING the custom Music-tab ordering: a small "Featured"
-- rail of up to four of the owner's own songs, pinned to the top of their Music
-- tab.
--
-- Run manually in the Supabase SQL editor. ADDITIVE: one nullable column.
--
-- WHY THIS INSTEAD OF ORDERING. Reordering a whole catalogue is work that never
-- ends — every new song reopens the question of where it goes — and the result
-- is invisible to a visitor, who cannot tell a deliberate order from a default
-- one. Four pinned songs are a statement anyone can read at a glance: this is
-- what I want you to hear first. It also stays finished. Adding a song does not
-- disturb it.
--
-- `music_featured` is a jsonb ARRAY of the owner's own audio-post ids, at most
-- four, in the order they should appear. Missing or deleted ids are skipped at
-- render time, so a stale list degrades to a shorter rail rather than a gap.
-- Null/absent = no rail at all, which is the default and the common case.
--
-- profiles.music_order is deliberately LEFT IN PLACE and simply unused. Dropping
-- a column that existing rows still carry buys nothing and cannot be undone;
-- leaving it costs a few bytes and keeps the door open if ordering ever returns.
--
-- Editing is Premium-gated in the app; the column inherits the existing profiles
-- RLS — the owner updates their own row, everyone can read it, which is what
-- lets a visitor see the rail too.

alter table public.profiles
  add column if not exists music_featured jsonb;

-- Verify:
--   select column_name, data_type from information_schema.columns
--    where table_schema = 'public' and table_name = 'profiles'
--      and column_name = 'music_featured';
--
-- How many profiles have picked any (expect 0 immediately after running):
--   select count(*) from public.profiles
--    where music_featured is not null and jsonb_array_length(music_featured) > 0;
