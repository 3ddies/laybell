-- Shop display preference — how a seller's OPEN shop appears on their PUBLIC
-- profile, chosen by the seller:
--   'button' (default) = the plain green "Shop" button
--   'rail'             = a card previewing a few listing covers
--
-- Run in the Supabase Dashboard → SQL Editor (the anon key cannot alter tables).
-- Until applied the column is absent → reads are null (the app treats null as
-- 'button') and writes are ignored, so the app keeps working either way.
--
-- No new RLS needed: a seller updates their own row under the existing profiles
-- update policy (auth.uid() = id); the value is public, read with the profile.
alter table public.profiles
  add column if not exists shop_display text not null default 'button'
    check (shop_display in ('button', 'rail'));
