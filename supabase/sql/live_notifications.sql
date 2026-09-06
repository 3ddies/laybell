-- "Someone you follow went live", and the realtime plumbing the whole app has
-- been missing.
--
--   npx supabase db query --linked -f supabase/sql/live_notifications.sql
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PART 1 IS A BUG FIX, AND A BIG ONE
--
-- The app subscribes to postgres_changes on notifications, messages, comments,
-- message_reactions and live_streams. NONE of those tables were in the
-- supabase_realtime publication, so every one of those subscriptions has been
-- silently dead in production. There is no polling fallback. In the shipped app
-- that means: a DM does not appear until you leave the conversation and come
-- back, a comment does not appear live, the unread badge does not move, and the
-- live rail does not notice someone going live.
--
-- The handlers themselves are fine — written carefully, and defensively enough
-- to survive being switched on (the comments one already ignores your own
-- insert so it cannot double-append). They have simply never run.
--
-- This is the THIRD time this project has been caught by it, which is why
-- checking pg_publication_tables is the first thing to do when realtime does not
-- fire. A table can exist, have RLS, have a working handler, and publish
-- nothing.
--
-- SAFETY: realtime enforces RLS on postgres_changes — a subscriber only receives
-- rows they could SELECT. Verified before adding each table below: all seven
-- have RLS enabled with SELECT policies. Publishing a table with RLS OFF would
-- broadcast every row of it to every subscriber.

-- 1) The publication ─────────────────────────────────────────────────────────
-- add-if-missing, so this is safe to re-run.
do $$
declare
  t text;
  wanted text[] := array[
    'notifications',      -- the unread badge, and every live banner
    'messages',           -- DMs appearing without leaving the thread
    'comments',           -- comments appearing under a post
    'message_reactions',  -- tapbacks
    'live_streams',       -- the live rail, and the go-live notification
    'posts'               -- "someone you follow posted" banners
  ];
begin
  foreach t in array wanted loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
      raise notice 'published %', t;
    end if;
  end loop;
end $$;

-- 2) The notification type ───────────────────────────────────────────────────
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type = any (array[
    'like','comment','follow','friend','message','mention',
    'song_used','song_story','tag','offer','studio_invite',
    'system','live_started'
  ]));

-- 3) Tell followers when someone goes live ───────────────────────────────────
-- SECURITY DEFINER because the broadcaster cannot write rows into other
-- people's notifications under RLS — the same shape as every other notification
-- this app creates.
create or replace function public.notify_followers_live()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_tokens jsonb;
  v_name   text;
begin
  -- ONLY the transition into 'live'. live_streams takes a heartbeat UPDATE
  -- roughly every 15 seconds while a stream runs, and without this guard every
  -- follower would be notified four times a minute for the whole broadcast.
  if new.status <> 'live' or (tg_op = 'UPDATE' and old.status = 'live') then
    return new;
  end if;

  -- A host who stops and restarts should not re-notify. Two hours is long
  -- enough to cover a dropped connection and a restart, short enough that a
  -- genuinely separate broadcast later in the day still gets announced.
  if exists (
    select 1 from public.notifications n
     where n.actor_id = new.user_id
       and n.type = 'live_started'
       and n.created_at > now() - interval '2 hours'
  ) then
    return new;
  end if;

  insert into public.notifications (user_id, actor_id, type, read)
  select f.follower_id, new.user_id, 'live_started', false
    from public.follows f
    -- Never notify a follower who has since been blocked, or who blocked the
    -- host. RLS would hide the row from them anyway; this stops writing it.
   where f.following_id = new.user_id
     and not exists (
       select 1 from public.blocks b
        where (b.blocker_id = f.follower_id and b.blocked_id = new.user_id)
           or (b.blocker_id = new.user_id and b.blocked_id = f.follower_id)
     );

  -- The push. Followers with a registered device, batched into one request the
  -- way send_reengagement_nudges does. Expo takes 100 per call, which is the
  -- limit here too; beyond that this needs paging, and the count is worth
  -- watching as the app grows.
  select coalesce(p.display_name, p.username, 'Someone') into v_name
    from public.profiles p where p.id = new.user_id;

  select jsonb_agg(jsonb_build_object(
           'to', t.token,
           'title', 'Laybell',
           'body', v_name || ' is live now.',
           'sound', 'default',
           'data', jsonb_build_object('type', 'live_started', 'liveId', new.id)
         ))
    into v_tokens
    from public.follows f
    join public.push_tokens t on t.user_id = f.follower_id
   where f.following_id = new.user_id
     and not exists (
       select 1 from public.blocks b
        where (b.blocker_id = f.follower_id and b.blocked_id = new.user_id)
           or (b.blocker_id = new.user_id and b.blocked_id = f.follower_id)
     )
   limit 100;

  if v_tokens is not null then
    perform net.http_post(
      url     := 'https://exp.host/--/api/v2/push/send',
      body    := v_tokens,
      headers := jsonb_build_object('Content-Type', 'application/json')
    );
  end if;

  return new;
exception when others then
  -- A broadcast must NEVER fail because the announcement failed. Going live is
  -- the thing the user asked for; telling people about it is a courtesy.
  raise warning 'notify_followers_live failed for stream %: %', new.id, sqlerrm;
  return new;
end;
$$;

drop trigger if exists live_streams_notify_followers on public.live_streams;
create trigger live_streams_notify_followers
  after insert or update of status on public.live_streams
  for each row execute function public.notify_followers_live();

-- ─── Verify ─────────────────────────────────────────────────────────────────
select
  (select string_agg(tablename, ', ' order by tablename)
     from pg_publication_tables where pubname = 'supabase_realtime')      as published_now,
  (select count(*) from pg_publication_tables
    where pubname = 'supabase_realtime'
      and tablename in ('notifications','messages','comments',
                        'message_reactions','live_streams','posts'))      as want_6,
  (select count(*) from pg_trigger
    where tgname = 'live_streams_notify_followers')                       as trigger_want_1;
