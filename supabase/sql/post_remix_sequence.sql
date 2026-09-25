-- Remix (owner, 2026-09-23; combined 2026-09-23).
--
-- A post can reference an ORIGINAL post it reacts to. Remix + Sequence began as
-- two menu items; they were too alike, so they are one "Remix" now with a chosen
-- LAYOUT for how the two clips sit together. The two OFFERED today are corner
-- overlays (they suit a vertical reaction):
--   * pip           — the original as a small top-right window over your full clip.
--   * pip_flip      — your reaction as a small top-right window over the full original.
--   * green_screen  — you keyed over the original as a background. RESERVED here
--                     but not offered yet: true keying needs on-device person
--                     segmentation (native), so it lands with the native bake — it
--                     will apply to the two views above.
--   * side_by_side / top_bottom — RETIRED as offerings (looked poor full-screen in
--                     reels); kept in the constraint so any older post still resolves.
--
-- The new post is an ordinary video post (its own media_url, thumbnail, etc.);
-- these two columns just record what it reacts to and how to lay the two out. For
-- now composition happens at PLAYBACK in the app (JS) — there is no baked file —
-- so the viewer reads source_post_id to fetch and lay out the original.
--
-- composition_kind holds the LAYOUT (the discriminator that a post is a remix at
-- all is simply source_post_id/composition_kind being set). on delete set null:
-- if the original is removed, the remix keeps playing your own clip; the viewer
-- falls back to that alone.

alter table public.posts
  add column if not exists source_post_id uuid references public.posts(id) on delete set null;

-- composition_kind holds either a COMMENTARY layout (the two play together) or
-- 'add' (the original plays first, then your clip — see source_trim_* for the
-- portion of the original used).
alter table public.posts
  add column if not exists composition_kind text;

-- For 'add' mode: the slice of the ORIGINAL to play before your clip (seconds on
-- the original's clock). Null = play it uncropped.
alter table public.posts
  add column if not exists source_trim_start numeric;
alter table public.posts
  add column if not exists source_trim_end numeric;

-- Replace the old ('remix','sequence') check with the layout set + 'add'. Safe to
-- re-run; there are no composition posts in prod yet (verified 2026-09-23). pip_flip
-- added 2026-09-25 (the inverse corner view).
alter table public.posts drop constraint if exists posts_composition_kind_check;
alter table public.posts add constraint posts_composition_kind_check
  check (composition_kind is null or composition_kind in
    ('pip', 'pip_flip', 'side_by_side', 'top_bottom', 'green_screen', 'add'));

-- Find a post's remixes, and resolve a composition's source quickly.
create index if not exists posts_source_post_idx on public.posts (source_post_id)
  where source_post_id is not null;
