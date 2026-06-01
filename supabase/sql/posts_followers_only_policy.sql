-- Followers-only post visibility — Supabase RLS
-- Run in the Supabase Dashboard → SQL Editor (anon key cannot alter policies).
--
-- Verified current SELECT policy on public.posts:
--   "Anyone can view public posts"  ->  USING (is_public = true)
-- That is the ONLY select policy, so private posts are unreadable by anyone
-- via the API — including their own author. The two additive policies below
-- fix that. They are PERMISSIVE, so Postgres OR's them with the existing
-- public policy; nothing that works today is changed.

-- A user can always read their own posts (public or private).
create policy "Users can view own posts"
on public.posts for select
using (auth.uid() = user_id);

-- Followers can read the posts of accounts they follow (this is what makes
-- "followers only" visible to followers; public posts are already covered).
create policy "Followers can view followed posts"
on public.posts for select
using (
  exists (
    select 1 from public.follows f
    where f.follower_id = auth.uid()
      and f.following_id = posts.user_id
  )
);

-- After running, a post is readable when:
--   is_public = true  OR  you are the author  OR  you follow the author.
-- The client queries in app/(tabs)/index.tsx (following feed) and
-- app/profile/[id].tsx already request these rows.
