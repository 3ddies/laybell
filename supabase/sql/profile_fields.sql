-- Profile fields: external link, gender, age — Supabase columns
-- Run in the Supabase Dashboard → SQL Editor (the anon key cannot alter tables).
-- Until applied, the new Edit-Profile fields and the onboarding About-you step
-- read/write nothing (the columns are absent → writes are ignored, reads are
-- null), so the app keeps working either way.
--
-- - link:   an optional external URL shown under the user's bio on their profile
--           (public). Tappable; opens in the browser.
-- - gender: collected at onboarding and editable later from a fixed preset list.
--           PRIVATE — never shown on the public profile; used only for the
--           account itself / future personalization.
-- - age:    collected (required) at onboarding. PRIVATE — stored only, not shown.
alter table public.profiles
  add column if not exists link   text,
  add column if not exists gender text,
  add column if not exists age    integer;
