-- Draggable / resizable story caption (TikTok / Instagram style). The caption
-- text still lives in stories.caption; this stores WHERE/how it's placed on the
-- media as a normalized transform so the viewer can re-render it at the same spot
-- across any screen size:
--   caption_style jsonb = { x, y, scale, rotation }
--     x, y     — center of the text, 0..1 of the frame (0.5,0.5 = centered)
--     scale    — font scale multiplier (pinch)
--     rotation — degrees
-- null = no custom placement → the old default (near the bottom).
--
-- Run this in the Supabase dashboard SQL editor. Safe to re-run.

alter table public.stories add column if not exists caption_style jsonb;
