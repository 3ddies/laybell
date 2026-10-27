-- Profile title / position — a short, OPTIONAL public headline shown in BOLD
-- directly under the user's name on their profile (e.g. "Producer", "Rapper",
-- "Audio Engineer", "A&R").
--
-- Run in the Supabase Dashboard → SQL Editor (the anon key cannot alter tables).
-- Until applied, the Edit-Profile "Title" field reads/writes nothing (the column
-- is absent → writes are ignored, reads are null), so the app keeps working
-- either way. PUBLIC — shown on the profile; the client caps length at 40 chars.
alter table public.profiles
  add column if not exists title text;
