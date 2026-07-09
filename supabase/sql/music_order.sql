-- Premium perk: custom ordering of a user's profile Music tab.
--
-- `music_order` is a jsonb ARRAY of the user's own audio-post ids, in the exact
-- order they want them to appear in their Music tab. At render time the listed
-- ids come first (in this order); any tracks NOT in the list fall back to the
-- default order (newest-first) at the end, and deleted/missing ids are skipped.
-- Null/absent = default order (no customization).
--
-- Editing is gated to Premium in the app (lib/entitlements isPremium); the column
-- itself inherits the existing profiles RLS — the owner updates their own row,
-- everyone can read it (so the custom order shows to profile visitors too).
alter table public.profiles
  add column if not exists music_order jsonb;
