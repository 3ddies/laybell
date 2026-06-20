-- Page Layout / Profile Templates — Supabase columns
-- Run in the Supabase Dashboard → SQL Editor (the anon key cannot alter tables).
-- Until applied, the Page Layout builder and the templated profile grid read/write
-- nothing (the columns are absent → writes are ignored, reads are null), so the
-- app keeps working exactly as before — every profile just shows the default grid.
--
-- The feature (see lib/pageLayout.ts) lets users who have earned a high enough
-- badge tier rearrange the FIRST profile tab (Posts) into "feature blocks":
--   • Media Star  (Gold)    — clusters of 1 image/video + 2 of their own songs
--   • Big Picture (Silver)  — one 2×2 hero media + 2 regular 1×1 medias
--   • Big Bell    (Diamond) — any mix of the above + one ≤12s autoplay video loop
--
-- - page_layout:  which template the profile is using. null / 'default' = the
--                 normal 3-column grid. Other values: 'media_star' | 'big_picture'
--                 | 'big_bell'. Re-checked against the user's CURRENT earned badge
--                 tier on every render — if they drop below the template's required
--                 tier the layout is ignored and the grid falls back to default
--                 (the notes' "lose the status → lose the template" rule), without
--                 destroying the saved arrangement, so it returns if they rank back up.
-- - layout_blocks: the ordered arrangement itself — a JSON array of block objects:
--                 { "kind":"media_star",  "main": <postId>, "songs": [<postId>,<postId>] }
--                 { "kind":"big_picture", "big":  <postId>, "regulars": [<postId>,<postId>], "loop": false }
--                 Posts not referenced by any block render in the normal grid below
--                 the blocks. Blocks whose posts were deleted/archived are skipped
--                 at render time, so this never needs server-side cleanup.
alter table public.profiles
  add column if not exists page_layout   text,
  add column if not exists layout_blocks jsonb;
