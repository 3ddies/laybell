-- One-shot fix for genre tagging. Run the WHOLE thing in the Supabase SQL Editor.
-- Idempotent: safe to run more than once.

-- 1) RLS + policies on post_tags (drop-then-create so a re-run never errors).
alter table public.post_tags enable row level security;

drop policy if exists "Read tags of public posts" on public.post_tags;
create policy "Read tags of public posts" on public.post_tags
  for select using (
    exists (select 1 from public.posts p where p.id = post_tags.post_id and p.is_public = true)
  );

drop policy if exists "Tag your own posts" on public.post_tags;
create policy "Tag your own posts" on public.post_tags
  for insert with check (
    exists (select 1 from public.posts p where p.id = post_tags.post_id and p.user_id = auth.uid())
  );

-- 2) Backfill: tag your existing audio posts as 'rap'.
--    Uses your account email (change it if your app login uses a different one).
--    This runs as the table owner so it bypasses RLS — it will work regardless.
--    NOTE: this tags ALL of your audio posts as rap. If some aren't rap, use the
--    SELECT below first to find the specific ids and insert only those instead.
insert into public.post_tags (post_id, genre, tag)
select p.id, 'rap', 'rap'
from public.posts p
where p.user_id = (select id from auth.users where email = '3ddiehall@gmail.com')
  and p.type = 'audio'
  and not exists (select 1 from public.post_tags t where t.post_id = p.id and t.genre = 'rap');

-- 3) Verify it worked:
select genre, count(*) from public.post_tags group by genre;

-- (Optional) list your audio posts with their current tags, to inspect:
-- select p.id, p.caption, t.genre
-- from public.posts p
-- left join public.post_tags t on t.post_id = p.id
-- where p.user_id = (select id from auth.users where email = '3ddiehall@gmail.com')
--   and p.type = 'audio'
-- order by p.created_at desc;
