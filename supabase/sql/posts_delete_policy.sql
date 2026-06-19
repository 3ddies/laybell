-- Owner can DELETE their own posts — Supabase RLS
-- Run in the Supabase Dashboard → SQL Editor (the anon key cannot alter policies).
--
-- THE BUG THIS FIXES: public.posts had SELECT / INSERT / UPDATE policies but NO
-- DELETE policy. Under RLS a delete with no matching policy removes ZERO rows
-- and PostgREST reports it as SUCCESS (no error). So `deletePostById` saw
-- `error == null`, returned true, the post vanished optimistically — then
-- reappeared on the next live fetch (music section, profile, feed) because the
-- row was never actually deleted, and it stayed playable because its row + media
-- still existed. Deleting "all audios" left every one of them in place.
--
-- This adds the missing rule: a user may delete their own posts. Cascades
-- (likes/saves/streams/reposts/views/playlist_tracks/ad_campaigns/…) then clean
-- up automatically per their own ON DELETE CASCADE FKs. Idempotent — safe to re-run.

drop policy if exists "Users can delete own posts" on public.posts;
create policy "Users can delete own posts"
on public.posts for delete
using (auth.uid() = user_id);
