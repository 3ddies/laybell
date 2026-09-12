-- Scheduled posts (1.0.3): a post that goes live at a time its author chooses.
--
--   npx supabase db query --linked -f supabase/sql/post_scheduling.sql
--
-- HOW IT WORKS
--   posts.publish_at   NULL for a post that is live — every post before this file,
--                      and every post made without a schedule. A time for one that
--                      is waiting.
--   the policy below   hides a post from everyone but its author until publish_at
--                      has passed. RESTRICTIVE, so it ANDs with every visibility
--                      rule already on posts: friends-only, the song-artist policy,
--                      the share page (it reads with the anon key) and realtime all
--                      honour it without being touched.
--   publish_scheduled_posts(), every minute
--                      takes each post whose time has come, gives it its place in
--                      the feeds (created_at = its publish time, publish_at = NULL) and
--                      sends what the app sends the moment an unscheduled post goes
--                      up — @mentions in the caption, tagged people, the song's
--                      artist, a track's credited collaborators — as notification
--                      rows and pushes. The app cannot: at that moment its author
--                      may not even have it open.
--
-- WHAT IT DELIBERATELY LEAVES OUT
--   Spotlight — the app refuses to schedule a post with a paid spotlight, whose
--   campaign clock would run while the post sat hidden. Badges — the Posts badge
--   counts live posts whenever it next evaluates. "Your post is live" for the
--   author — a local reminder on their phone (lib/scheduleNotify), not a push.
--
-- Older app versions never write publish_at, so nothing changes for them except
-- that someone else's scheduled post stays out of their feeds until its time, which
-- is the point. Additive and safe to re-run.

-- 1) The column ────────────────────────────────────────────────────────────────
alter table public.posts add column if not exists publish_at timestamptz;

-- The publisher's scan covers only posts still waiting — almost none at any time.
create index if not exists posts_publish_at_waiting_idx
  on public.posts (publish_at)
  where publish_at is not null;

-- 2) Hidden until its time ───────────────────────────────────────────────────
-- Author-exempt, because Postgres applies SELECT policies to the rows an UPDATE or
-- DELETE touches: without the exemption the author could not edit, reschedule or
-- delete their own scheduled post, and the upload queue could not mark its video
-- ready. Visibility is by TIME, not by the publisher having run, so a post goes
-- live on the minute even if the job is late.
drop policy if exists "Scheduled posts hidden until publish" on public.posts;
create policy "Scheduled posts hidden until publish"
  on public.posts as restrictive for select
  using (
    -- Cheapest test first: nearly every row is settled by it.
    publish_at is null
    or publish_at <= now()
    or user_id = auth.uid()
  );

-- 3) The publisher ────────────────────────────────────────────────────────────
-- SECURITY DEFINER: it writes notification and mention rows on the author's
-- behalf, which RLS would refuse anyone but the author — the same shape as
-- notify_followers_live (live_notifications.sql).
create or replace function public.publish_scheduled_posts()
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  r        record;
  v_done   integer := 0;
  v_name   text;
  v_batch  jsonb;
  v_msgs   jsonb := '[]'::jsonb;
  v_total  integer;
  v_offset integer := 0;
begin
  for r in
    select p.id, p.user_id, p.type, p.caption, p.publish_at, p.archived_at,
           p.tagged_user_ids, p.song_artist_id, p.features
      from public.posts p
     where p.publish_at is not null
       and p.publish_at <= now()
     order by p.publish_at
     limit 200
     for update skip locked
  loop
    -- Live first, in its own statement. If announcing it fails below, the post is
    -- still published — and is never picked up again, so a broken announcement
    -- cannot turn into a retry storm. Its place in the feeds is the moment it went
    -- live, never earlier than the row itself: a publish_at written into the past
    -- cannot backdate a post.
    update public.posts
       set created_at = greatest(created_at, r.publish_at),
           publish_at = null
     where id = r.id;
    v_done := v_done + 1;

    -- Archived while it waited: live in name only, so nobody is told about it.
    if r.archived_at is not null then
      continue;
    end if;

    begin
      select coalesce('@' || pr.username, pr.display_name, 'Someone')
        into v_name
        from public.profiles pr
       where pr.id = r.user_id;
      v_name := coalesce(v_name, 'Someone');

      with recipients as (
        -- @mentions in the caption: lib/mentions' pattern, and usernames are stored
        -- lowercase.
        select pr.id as uid, 'mention'::text as kind
          from regexp_matches(coalesce(r.caption, ''), '@([A-Za-z0-9_]{2,30})', 'g') as m(g)
          join public.profiles pr on pr.username = lower(m.g[1])
        union
        -- People tagged on a photo, slideshow or video.
        select t.uid, 'tag'
          from unnest(coalesce(r.tagged_user_ids, '{}'::uuid[])) as t(uid)
         where r.type not in ('audio', 'podcast', 'audiobook')
        union
        -- A track's credited collaborators who have an account (a typed credit
        -- carries a name and no id). The CASE is what keeps a malformed id from
        -- failing the cast; a WHERE filter promises no order once the planner
        -- pushes the outer conditions down into this branch.
        select case when (f.value ->> 'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    then (f.value ->> 'id')::uuid end, 'tag'
          from jsonb_array_elements(
                 case when jsonb_typeof(r.features) = 'array' then r.features else '[]'::jsonb end
               ) as f(value)
         where r.type in ('audio', 'podcast', 'audiobook')
        union
        -- The artist whose song plays on it.
        select r.song_artist_id, 'song_used'
         where r.song_artist_id is not null
           and r.type not in ('audio', 'podcast', 'audiobook')
      ),
      eligible as (
        select distinct rc.uid, rc.kind
          from recipients rc
         where rc.uid is not null
           and rc.uid <> r.user_id
           and exists (select 1 from public.profiles pr where pr.id = rc.uid)
           and not exists (
             select 1 from public.blocks b
              where (b.blocker_id = rc.uid and b.blocked_id = r.user_id)
                 or (b.blocker_id = r.user_id and b.blocked_id = rc.uid)
           )
           -- Once per person, kind and post, however many times this runs.
           and not exists (
             select 1 from public.notifications n
              where n.user_id = rc.uid
                and n.actor_id = r.user_id
                and n.type = rc.kind
                and n.post_id = r.id
           )
      ),
      mentioned as (
        insert into public.mentions (mentioned_user_id, actor_id, post_id)
        select e.uid, r.user_id, r.id
          from eligible e
         where e.kind = 'mention'
           and not exists (
             select 1 from public.mentions mm
              where mm.mentioned_user_id = e.uid
                and mm.post_id = r.id
                and mm.comment_id is null
           )
        returning 1
      ),
      notified as (
        insert into public.notifications (user_id, actor_id, type, post_id)
        select e.uid, r.user_id, e.kind, r.id
          from eligible e
        returning user_id, type
      )
      select coalesce(jsonb_agg(jsonb_build_object(
               'to', tk.token,
               'title', 'Laybell',
               -- The same words send-push uses for these types.
               'body', v_name || case n.type
                                   when 'mention' then ' mentioned you.'
                                   when 'tag' then ' tagged you in a post.'
                                   else ' used your audio in a post.'
                                 end,
               'sound', 'default',
               'data', jsonb_build_object('type', n.type, 'postId', r.id)
             )), '[]'::jsonb)
        into v_batch
        from notified n
        join public.push_tokens tk on tk.user_id = n.user_id;

      v_msgs := v_msgs || v_batch;
    exception when others then
      raise warning 'publish_scheduled_posts: announcing post % failed: %', r.id, sqlerrm;
    end;
  end loop;

  -- The pushes, 100 to a request (Expo's limit). A failure here must not undo the
  -- publishing above.
  begin
    v_total := jsonb_array_length(v_msgs);
    while v_offset < v_total loop
      select jsonb_agg(e.value order by e.ord)
        into v_batch
        from jsonb_array_elements(v_msgs) with ordinality as e(value, ord)
       where e.ord > v_offset and e.ord <= v_offset + 100;
      perform net.http_post(
        url     := 'https://exp.host/--/api/v2/push/send',
        body    := v_batch,
        headers := jsonb_build_object('Content-Type', 'application/json')
      );
      v_offset := v_offset + 100;
    end loop;
  exception when others then
    raise warning 'publish_scheduled_posts: sending pushes failed: %', sqlerrm;
  end;

  return v_done;
end;
$$;

-- Only the scheduler runs it. `revoke ... from public` alone does NOT stop anon —
-- revoke each role by name (supabase-sql-runner lesson).
revoke all on function public.publish_scheduled_posts() from public;
revoke all on function public.publish_scheduled_posts() from anon;
revoke all on function public.publish_scheduled_posts() from authenticated;

-- 4) Every minute ─────────────────────────────────────────────────────────────
select cron.unschedule('publish-scheduled-posts')
 where exists (select 1 from cron.job where jobname = 'publish-scheduled-posts');
select cron.schedule('publish-scheduled-posts', '* * * * *', $$select public.publish_scheduled_posts();$$);

-- PostgREST has to see the column before the app can filter on it.
notify pgrst, 'reload schema';

-- ─── Verify ─────────────────────────────────────────────────────────────────
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'posts' and column_name = 'publish_at')    as column_want_1,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'posts'
      and policyname = 'Scheduled posts hidden until publish' and permissive = 'RESTRICTIVE') as policy_want_1,
  (select count(*) from cron.job where jobname = 'publish-scheduled-posts' and active)        as job_want_1,
  -- The job runs as the role that scheduled it; it should match the other jobs'.
  (select username from cron.job where jobname = 'publish-scheduled-posts')                   as job_runs_as,
  (select string_agg(distinct username, ', ') from cron.job)                                  as every_job_runs_as,
  has_function_privilege('anon', 'public.publish_scheduled_posts()', 'execute')              as anon_can_run_want_false,
  has_function_privilege('authenticated', 'public.publish_scheduled_posts()', 'execute')     as signed_in_can_run_want_false;
