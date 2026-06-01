-- Genre tags (post_tags) RLS — Supabase
-- Run in the Supabase Dashboard → SQL Editor.
--
-- Symptom: songs tagged with a genre don't appear in that genre on Explore.
-- post_tags has columns (post_id, genre, tag). The genre browse reads post_tags
-- joined to posts; tagging happens at post time. Both need RLS policies.

-- ============================================================
-- STEP 1 (DIAGNOSTIC, read-only): run these to see the real state.
-- ============================================================
-- a) Do any tag rows exist, and for which genres?
select genre, count(*) from public.post_tags group by genre order by 2 desc;

-- b) What policies already exist on post_tags?
select policyname, cmd, qual, with_check from pg_policies where tablename = 'post_tags';

-- If (a) returns NO rows for 'rap', the tag INSERT was failing → add the insert
-- policy below, then re-post (existing posts can't be auto-tagged retroactively).
-- If (a) shows rows but Explore is still empty, you only need the SELECT policy.

-- ============================================================
-- STEP 2 (FIX): allow reading tags of public posts + tagging your own posts.
-- (Skip whichever already exists per Step 1b.)
-- ============================================================
alter table public.post_tags enable row level security;

create policy "Read tags of public posts" on public.post_tags
  for select using (
    exists (select 1 from public.posts p where p.id = post_tags.post_id and p.is_public = true)
  );

create policy "Tag your own posts" on public.post_tags
  for insert with check (
    exists (select 1 from public.posts p where p.id = post_tags.post_id and p.user_id = auth.uid())
  );
