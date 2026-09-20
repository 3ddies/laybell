-- Small copies and placeholders for post media — 1.0.4 (owner, 2026-09-19: close the
-- polish gap with Instagram). Grids load a ~480px copy instead of the full upload, and
-- every surface can draw a blurred placeholder (a thumbhash, ~30 characters) while the
-- real image loads, instead of an empty gray box.
--
--   npx supabase db query --linked -f supabase/sql/post_media_previews.sql
--
-- Both columns are nullable and nothing reads them before 1.0.4. Posts made before
-- this, and posts from older apps, have neither, and every surface falls back to what
-- it showed before. The small copy lives in the same `posts` bucket folder as the
-- post's other files, so account deletion (purge_profile_storage) already removes it;
-- post deletion removes it through lib/storageCleanup.collectPostMediaUrls.

alter table public.posts add column if not exists thumb_url text;
alter table public.posts add column if not exists placeholder text;

comment on column public.posts.thumb_url is
  '~480px JPEG of the post''s picture (photo, audio cover, video poster, slideshow cover) for grids. 1.0.4.';
comment on column public.posts.placeholder is
  'thumbhash (base64) of the post''s picture, drawn blurred while it loads. 1.0.4.';

-- Verify.
select
  count(*) filter (where column_name = 'thumb_url')   as thumb_url_must_be_1,
  count(*) filter (where column_name = 'placeholder') as placeholder_must_be_1
from information_schema.columns
where table_schema = 'public' and table_name = 'posts';
