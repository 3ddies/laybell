-- Video captions — TikTok-style text bubbles the creator places on a clip.
-- HORIZONTAL clips: top_caption lives in the black letterbox band above the
-- video (rotating to fullscreen hides it — the bar no longer exists there)
-- and bottom_caption in the band below. VERTICAL clips fill the screen, so
-- top_caption doubles as the free-placement screen caption (its y spans the
-- safe area between the back-button strip and the reel's bottom UI); a post
-- is one orientation or the other, so the column's meaning is unambiguous.
--
-- One jsonb column on posts so it rides along with select('*') everywhere
-- (same pattern as slides / story caption_style):
--   { "text":  "…\n…",       -- caption lines
--     "bg":    "#FFFFFF",    -- bubble color
--     "color": "#111111",    -- text color
--     "y":     0.35,         -- 0..1 position within the safe band zone
--     "scale": 1.0 }         -- pinch size multiplier
--
-- Written spread-conditionally by the video upload queue, so until this file
-- is applied the insert simply omits the column — a safe no-op.

alter table public.posts add column if not exists top_caption jsonb;

-- ── v2: bottom caption ────────────────────────────────────────────────────────
-- Same bubble, same jsonb shape, parked in the BOTTOM letterbox band (kept
-- clear of the reel's meta block / action rail / scrub bar by the app's zone
-- math). Re-run this whole file to apply — both statements are idempotent.
alter table public.posts add column if not exists bottom_caption jsonb;
