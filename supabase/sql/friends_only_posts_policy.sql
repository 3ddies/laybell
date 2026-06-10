-- Friends-only post visibility — Supabase RLS
-- Run in the Supabase Dashboard → SQL Editor (the anon key cannot alter policies).
--
-- Laybell now has two connection tiers:
--   • Follower = one-directional (you follow them).        Sees PUBLIC posts.
--   • Friend   = mutual follow (you follow each other).    Also sees PRIVATE posts.
--
-- This REPLACES the older "Followers can view followed posts" policy (which let any
-- one-directional follower read private posts). Private posts (is_public = false)
-- are now visible only to the author and to friends (mutual follows). Public posts
-- are unaffected — they stay covered by "Anyone can view public posts", and authors
-- keep "Users can view own posts".
--
-- A post is readable after this runs when:
--   is_public = true  OR  you are the author  OR  you and the author follow each other.

-- Drop the old followers-only rule if it exists (created by posts_followers_only_policy.sql).
drop policy if exists "Followers can view followed posts" on public.posts;

-- Ensure the author can always read their own posts (idempotent — created earlier too).
drop policy if exists "Users can view own posts" on public.posts;
create policy "Users can view own posts"
on public.posts for select
using (auth.uid() = user_id);

-- Friends (mutual follows) can read each other's private posts.
create policy "Friends can view private posts"
on public.posts for select
using (
  exists (
    select 1 from public.follows f1
    where f1.follower_id = auth.uid()
      and f1.following_id = posts.user_id
  )
  and
  exists (
    select 1 from public.follows f2
    where f2.follower_id = posts.user_id
      and f2.following_id = auth.uid()
  )
);
