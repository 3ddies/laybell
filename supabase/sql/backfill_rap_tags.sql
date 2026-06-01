-- Backfill genre tags for songs posted before the post_tags INSERT policy existed.
-- Run in the Supabase Dashboard → SQL Editor. Requires post_tags_policies.sql first.

-- 1) List your audio posts so you can identify the rap ones (replace your username):
select p.id, p.caption, p.created_at
from public.posts p
join public.profiles pr on pr.id = p.user_id
where pr.username = 'YOUR_USERNAME' and p.type = 'audio'
order by p.created_at desc;

-- 2) Tag the rap ones (paste the ids from step 1). genre + tag are stored lowercase.
insert into public.post_tags (post_id, genre, tag) values
  ('POST_ID_1', 'rap', 'rap'),
  ('POST_ID_2', 'rap', 'rap');

-- Shortcut: if EVERY audio post you've made is rap, tag them all at once instead
-- of listing ids (adjust the username):
-- insert into public.post_tags (post_id, genre, tag)
-- select p.id, 'rap', 'rap'
-- from public.posts p
-- join public.profiles pr on pr.id = p.user_id
-- where pr.username = 'YOUR_USERNAME' and p.type = 'audio'
--   and not exists (select 1 from public.post_tags t where t.post_id = p.id and t.genre = 'rap');
