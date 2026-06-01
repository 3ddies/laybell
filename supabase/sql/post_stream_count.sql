-- Stream (play) count per post — Supabase
-- Run in the Supabase Dashboard → SQL Editor.
--
-- Each time a track starts playing, the app calls increment_stream_count().
-- The function is SECURITY DEFINER so any listener can bump the counter without
-- having UPDATE rights on someone else's post.

alter table public.posts
  add column if not exists stream_count integer not null default 0;

create or replace function public.increment_stream_count(p_post_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.posts set stream_count = stream_count + 1 where id = p_post_id;
$$;

grant execute on function public.increment_stream_count(uuid) to anon, authenticated;
