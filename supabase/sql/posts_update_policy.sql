-- Owner can UPDATE their own posts — Supabase RLS
-- Run in the Supabase Dashboard → SQL Editor (the anon key cannot alter policies).
--
-- THE BUG THIS FIXES: archiving a post (and editing caption/visibility, and the
-- Spotlight "attach post" step) all UPDATE public.posts. The base RLS only ever
-- had SELECT / INSERT / DELETE policies for posts — there was no UPDATE policy.
-- Under RLS a row with no matching UPDATE policy is simply NOT updatable, and
-- PostgREST reports this as success with ZERO rows affected (no error). So
-- `archivePostById` saw `error == null`, returned success, the post vanished
-- optimistically — then reappeared on the next profile refresh because
-- archived_at was never actually written. The Archive screen stayed empty.
--
-- This adds the missing rule: a user may update their own posts (and only their
-- own — the WITH CHECK stops them from re-assigning a post to someone else).
-- Idempotent: safe to re-run.

drop policy if exists "Users can update own posts" on public.posts;
create policy "Users can update own posts"
on public.posts for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
