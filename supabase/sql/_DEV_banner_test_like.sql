-- Fire ONE 'like' notification at the owner's account so the banner's new
-- right-hand THUMBNAIL (TikTok-style post cover) can be watched arriving.
--
--   npx supabase db query --remote --yes -f supabase/sql/_DEV_banner_test_like.sql
--
-- Same real path as _DEV_banner_test.sql: a row is written to notifications,
-- Supabase realtime delivers the INSERT, and components/ActivityBanner renders
-- it. The only difference is this one is a 'like' on a real post of yours, so the
-- card carries a post_id and therefore a cover to show on the right.
--
-- It writes ONE row, on 3ddie's account only, from a random account they follow.
-- No like row is created and nobody else is touched — the actor does not actually
-- like anything; this is only the notification a like WOULD have produced. A raw
-- insert into notifications fires no push (the push path is client-side,
-- lib/createNotification), exactly like the live_started test.
--
-- HAVE THE APP OPEN AND ON THE HOME FEED (the banner is suppressed on
-- /notifications, which it would duplicate).

do $$
declare
  me    uuid;
  host  uuid;
  hname text;
  pid   uuid;
begin
  select id into me from public.profiles where username = '3ddie';
  if me is null then raise exception 'No account 3ddie.'; end if;

  -- A post of theirs that actually has a cover to show: a small copy, a video
  -- poster, an image, or an audio cover. Newest first.
  select id into pid
    from public.posts
   where user_id = me
     and archived_at is null
     and (thumb_url is not null or cover_url is not null or thumbnail_url is not null
          or type in ('image', 'video'))
   order by created_at desc
   limit 1;
  if pid is null then raise exception '3ddie has no post with a cover to show.'; end if;

  -- Someone they follow, for a real name and face on the left.
  select p.id, coalesce(p.display_name, p.username) into host, hname
    from public.follows f
    join public.profiles p on p.id = f.following_id
   where f.follower_id = me
     and coalesce(p.hidden, false) = false
   order by random() limit 1;
  if host is null then raise exception 'That account follows nobody to test with.'; end if;

  insert into public.notifications (user_id, actor_id, type, post_id, read)
  values (me, host, 'like', pid, false);

  raise notice 'Wrote a like from % on post % — watch for the banner (thumbnail on the right).', hname, pid;
end $$;

select n.id, n.type, p.username as from_who, n.post_id, n.read,
       to_char(n.created_at, 'HH24:MI:SS') as at
  from public.notifications n
  join public.profiles p on p.id = n.actor_id
 where n.user_id = (select id from public.profiles where username = '3ddie')
   and n.type = 'like'
 order by n.created_at desc
 limit 3;

-- ─── CLEANUP ────────────────────────────────────────────────────────────────
-- Delete the test row by the id printed above (don't blanket-delete likes —
-- real ones look the same):
--   delete from public.notifications where id = '<paste id from the list>';
