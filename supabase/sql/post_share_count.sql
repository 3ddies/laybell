-- Public per-post share count — Supabase
-- Run in the Supabase Dashboard → SQL Editor.
--
-- Shares aren't stored individually (there's no shares table); we just bump a
-- public counter on the post each time it's shared, via a SECURITY DEFINER RPC
-- so any signed-in user can increment the count on someone else's post.
-- Feeds select '*', so no client query change is needed to read it.

alter table public.posts
  add column if not exists share_count integer not null default 0;

create or replace function public.increment_share_count(p_post_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then return; end if;
  update public.posts set share_count = share_count + 1 where id = p_post_id;
end;
$$;

grant execute on function public.increment_share_count(uuid) to authenticated;
