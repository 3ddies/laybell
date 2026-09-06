-- Send ONE real push to a single account, to test that tapping it navigates.
--
--   npx supabase db query --linked -f supabase/sql/_DEV_test_push.sql
--
-- Sent from inside the database over pg_net, the same path
-- send_reengagement_nudges() uses. The point of doing it here rather than from a
-- script: the device token never leaves Supabase — it is read and posted in one
-- statement, so it never lands in a terminal, a log, or anyone's scrollback.
--
-- ⚠️ THIS REALLY BUZZES A PHONE. Only ever aimed at the owner's own account.
--
-- The payload decides where a tap lands — see lib/notificationRoute.ts:
--   {"type":"system","key":"followers"}   -> /followers/<their id>
--   {"type":"system","key":"earnings"}    -> /wallet
--   {"type":"system","key":"back"}        -> the composer tab
--   {"type":"badge_risk"}                 -> /badges
--   {"type":"like","postId":"<uuid>"}     -> that post
-- Change v_data below to test a different one.

do $$
declare
  v_token text;
  v_data  jsonb := '{"type":"system","key":"followers"}'::jsonb;
  v_body  text  := '3 people followed you while you were away.';
  v_req   bigint;
begin
  select t.token into v_token
    from public.push_tokens t
    join public.profiles p on p.id = t.user_id
   where p.username = '3ddie';

  if v_token is null then
    raise exception 'No push token for 3ddie. Open the app on the device once and allow notifications.';
  end if;

  select net.http_post(
    url     := 'https://exp.host/--/api/v2/push/send',
    body    := jsonb_build_array(jsonb_build_object(
                 'to', v_token,
                 'title', 'Laybell',
                 'body', v_body,
                 'sound', 'default',
                 'data', v_data)),
    headers := jsonb_build_object('Content-Type', 'application/json')
  ) into v_req;

  raise notice 'Queued push request % with data %', v_req, v_data;
end $$;

-- Expo's answer. pg_net is ASYNC, so this can be empty on the first run — wait a
-- second and select it again.
--
-- What to look for in `content`:
--   "status":"ok"                -> Expo accepted it; the phone should buzz
--   "DeviceNotRegistered"        -> that token is dead (app deleted/reinstalled);
--                                   reopen the app so it registers a fresh one
--   "MessageTooBig" / other      -> the payload is wrong, not the device
select id, status_code, left(content, 300) as content, error_msg
  from net._http_response
 order by id desc
 limit 1;
