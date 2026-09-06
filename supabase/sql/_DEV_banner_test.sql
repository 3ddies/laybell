-- Make ONE notification land on the owner's account so the live banner can be
-- watched arriving.
--
--   npx supabase db query --linked -f supabase/sql/_DEV_banner_test.sql
--
-- This is the real path: the row is written, Supabase realtime delivers the
-- INSERT to the subscribed client, and components/ActivityBanner turns it into
-- the banner. Nothing is faked on the client side.
--
-- It writes ONE row, on 3ddie's account only. No live_streams row is created,
-- so the go-live trigger does not fire and none of the host's other followers
-- are pushed or notified — they are real people and this is a test.
--
-- HAVE THE APP OPEN AND ON THE HOME FEED. The banner is deliberately suppressed
-- on /notifications (it would duplicate the list you are already reading) and
-- on /live for a live_started.

do $$
declare
  me   uuid;
  host uuid;
  hname text;
begin
  select id into me from public.profiles where username = '3ddie';
  if me is null then raise exception 'No account 3ddie.'; end if;

  -- Someone they actually follow, so the banner shows a real name and face.
  select p.id, coalesce(p.display_name, p.username) into host, hname
    from public.follows f
    join public.profiles p on p.id = f.following_id
   where f.follower_id = me
     and coalesce(p.hidden, false) = false
   order by random() limit 1;

  if host is null then raise exception 'That account follows nobody to test with.'; end if;

  delete from public.notifications
   where user_id = me and type = 'live_started' and actor_id = host;

  insert into public.notifications (user_id, actor_id, type, read)
  values (me, host, 'live_started', false);

  raise notice 'Wrote a live_started notification from % — watch for the banner.', hname;
end $$;

select n.id, n.type, p.username as from_who, n.read, to_char(n.created_at, 'HH24:MI:SS') as at
  from public.notifications n
  join public.profiles p on p.id = n.actor_id
 where n.user_id = (select id from public.profiles where username = '3ddie')
   and n.type = 'live_started';

-- ─── What to look for ───────────────────────────────────────────────────────
--   • A card drops in from the top WITHIN A SECOND. Slower than that and
--     realtime is not delivering — check pg_publication_tables first, it is
--     what has been wrong every previous time.
--   • Their real name and avatar, with a red radio dot on the corner.
--   • "<name>" bold, "is live now" underneath.
--   • It slides away on its own after about four seconds.
--   • The X dismisses it immediately.
--   • Tapping it opens the live rail.
--   • Open Notifications: the same event is there as a row, with the radio
--     emblem, reading "<name> went live".
--
-- ─── CLEANUP ────────────────────────────────────────────────────────────────
-- delete from public.notifications
--  where user_id = (select id from public.profiles where username = '3ddie')
--    and type = 'live_started';
