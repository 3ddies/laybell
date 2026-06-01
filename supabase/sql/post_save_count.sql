-- Public per-post save count (popularity) — Supabase
-- Run in the Supabase Dashboard → SQL Editor.
--
-- Keeps individual saves PRIVATE (saves table stays owner-only) while exposing
-- only an aggregate count on the public posts row. The trigger runs as
-- SECURITY DEFINER so it can update posts regardless of who saved.

-- 1) Denormalized public count on posts.
alter table public.posts
  add column if not exists save_count integer not null default 0;

-- 2) Backfill existing saves.
update public.posts p
set save_count = (select count(*) from public.saves s where s.post_id = p.id);

-- 3) Keep it in sync on save / unsave.
create or replace function public.sync_post_save_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'INSERT') then
    update public.posts set save_count = save_count + 1 where id = new.post_id;
  elsif (tg_op = 'DELETE') then
    update public.posts set save_count = greatest(save_count - 1, 0) where id = old.post_id;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_sync_post_save_count on public.saves;
create trigger trg_sync_post_save_count
after insert or delete on public.saves
for each row execute function public.sync_post_save_count();

-- After this, posts.save_count reflects total saves and displays next to the
-- like/comment counts on each post. The feed and post-detail queries already
-- select '*', so no client query change is needed.
