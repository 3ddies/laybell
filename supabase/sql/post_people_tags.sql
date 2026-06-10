-- People tags on posts (distinct from @mentions in text, and from the genre
-- `post_tags` table). A deliberate list of accounts the author tags when creating
-- a post/slideshow — up to 10. Stored as a uuid[] so it rides along with
-- `select('*')` everywhere; a GIN index makes "posts I'm tagged in" (.contains)
-- fast for the Tagged screen.
--
-- Run this in the Supabase dashboard SQL editor. Safe to re-run.
-- NOTE: also re-run tagged_mentions.sql once — it now allows the 'tag' notification
-- type in the notifications CHECK constraint.

alter table public.posts add column if not exists tagged_user_ids uuid[] default '{}';

create index if not exists posts_tagged_users_idx on public.posts using gin (tagged_user_ids);
