-- Story viewer-list retention (1.0.9).
--
-- A story runs for 24h (stories.expires_at), then lives on in its author's archive
-- (lib/stories fetchArchivedStories — expired, never deleted). Its per-viewer rows in
-- public.story_views (ONE row per person who saw it) pile up forever across every story
-- ever posted, for data nobody looks at anymore. 48 HOURS AFTER a story expires this
-- drops the plain-viewer rows — but KEEPS, by design:
--   • the view NUMBER  — snapshotted onto stories.view_count BEFORE anything is dropped;
--   • the LIKERS       — story_likes is never touched, and a liker keeps their view row;
--   • the COMMENTERS   — a story comment is the `comment` column ON story_likes, so the
--                        same rule keeps them too.
-- The app reads the count as coalesce(stories.view_count, live count of story_views), so
-- it shows the live count until the purge, then the snapshot after (see lib/stories).

alter table public.stories add column if not exists view_count int;

create or replace function public.purge_old_story_views()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Snapshot the TOTAL view count once, before any rows are dropped, so the archive
  -- keeps the number after the plain-viewer rows are gone.
  update public.stories s
  set view_count = (select count(*) from public.story_views sv where sv.story_id = s.id)
  where s.expires_at < now() - interval '48 hours'
    and s.view_count is null;

  -- Drop the plain-viewer rows, keeping anyone who LIKED or COMMENTED (both live on
  -- story_likes). The archive then shows the count, the likers and the commenters —
  -- nothing else.
  delete from public.story_views sv
  using public.stories s
  where sv.story_id = s.id
    and s.expires_at < now() - interval '48 hours'
    and not exists (
      select 1 from public.story_likes sl
      where sl.story_id = sv.story_id and sl.user_id = sv.viewer_id
    );
end;
$$;

-- Housekeeping only; clients never call it.
revoke all on function public.purge_old_story_views() from public;
revoke all on function public.purge_old_story_views() from anon;
revoke all on function public.purge_old_story_views() from authenticated;

-- Schedule hourly with pg_cron (run once in the SQL editor, after the function):
--   select cron.schedule('purge-old-story-views', '23 * * * *',
--     $$select public.purge_old_story_views()$$);
