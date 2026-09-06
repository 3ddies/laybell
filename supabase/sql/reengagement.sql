-- Laybell's re-engagement nudges: a notification from Laybell itself, sent to an
-- account that has been away a long time.
--
--   npx supabase db query --linked -f supabase/sql/reengagement.sql
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS DEFAULTS TO **FALSE**, UNLIKE THE EMAIL LIST
--
-- The email list (email_marketing_optin.sql) defaults to TRUE, and that is
-- lawful: US commercial email is CAN-SPAM, an opt-OUT regime, and a pre-ticked
-- box is fine. It is tempting to copy that here. Do not.
--
-- Push is governed by Apple, not CAN-SPAM, and App Store Review Guideline 4.5.4
-- says, verbatim:
--
--     "Push Notifications ... should not be used for promotions or direct
--      marketing purposes unless customers have explicitly opted in to receive
--      them via consent language displayed in your app's UI, and you provide a
--      method in your app for a user to opt out from receiving such messages.
--      Abuse of these services may result in revocation of your privileges."
--
-- "Explicitly opted in" rules out a pre-ticked box, so this column defaults to
-- false and only an unticked checkbox the user ticks themselves turns it on.
-- The opt-out half is the same toggle, in Settings → Notifications.
--
-- These messages ARE the promotional kind: "come back and post" is by intent a
-- re-engagement campaign, whatever else it also is. Do not talk yourself into
-- calling them transactional.
--
-- MINORS ARE EXCLUDED outright, the same as the email list, and for the same
-- reason: 13-17s are here on parental consent and re-engagement marketing aimed
-- at a fifteen-year-old is a fight nobody needs.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THE MESSAGES MAY SAY
--
-- Every message is conditioned on something TRUE about that account, checked at
-- send time — money waiting, followers gained, unread notifications, no posts
-- yet. That is not decoration. A nudge that says "people are waiting for you"
-- to someone with no followers is the kind of thing that gets an app deleted,
-- and it is the reason the generic message is last rather than first.
--
-- NO AMOUNTS, EVER. 4.5.4 also says push "should not be used to send sensitive
-- personal or confidential information", and a wallet balance on a lock screen
-- is exactly that. The earnings message says money is waiting and never how
-- much. The amount is in the app, behind their login, where it belongs.

-- 1) The consent + cadence columns ───────────────────────────────────────────
alter table public.profiles
  add column if not exists reengage_opt_in    boolean not null default false;
alter table public.profiles
  add column if not exists reengage_opt_in_at timestamptz;
alter table public.profiles
  add column if not exists reengage_last_at   timestamptz;
alter table public.profiles
  add column if not exists reengage_count     integer not null default 0;

-- There is deliberately no "last message sent" column. Which messages an account
-- has already heard is derived from the notifications actually sent to them (see
-- reengagement_due), so the two can never drift apart, and it resets itself the
-- moment they come back — the same trick the count uses.
--
-- An earlier draft of this file did add reengage_last_key, and it shipped to
-- production before a test showed that remembering ONE key lets two applicable
-- messages alternate forever. Dropped here so a database that ran that draft
-- ends up matching this file.
alter table public.profiles drop column if exists reengage_last_key;

comment on column public.profiles.reengage_opt_in is
  'Receives Laybell re-engagement push. Defaults FALSE — App Store guideline 4.5.4 requires an explicit opt-in for promotional push. Do NOT change this default to true.';
comment on column public.profiles.reengage_count is
  'Nudges sent during the CURRENT absence. Resets on its own once last_seen_at passes reengage_last_at — see reengagement_due().';

-- 2) The notification row ────────────────────────────────────────────────────
-- A message from Laybell has no actor: actor_id stays null, which the column
-- already allows. system_key names WHICH message, and the app translates it —
-- so the copy can be reworded, or a new language added, without a migration.
-- system_n carries the one number a message may interpolate ("3 people followed
-- you"); null when the message has no number.
alter table public.notifications add column if not exists system_key text;
alter table public.notifications add column if not exists system_n   integer;

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type = any (array[
    'like','comment','follow','friend','message','mention',
    'song_used','song_story','tag','offer','studio_invite',
    'system'
  ]));

-- A system row must name its message, and only a system row may.
alter table public.notifications drop constraint if exists notifications_system_key_check;
alter table public.notifications add constraint notifications_system_key_check
  check ((type = 'system') = (system_key is not null));

-- 3) Who is due, and what they should hear ───────────────────────────────────
-- READ-ONLY, and separate from the sender on purpose: "show me who would be
-- nudged today and with what" is then a plain select that sends nothing. Every
-- rule that decides whether a push goes out lives here and nowhere else.
create or replace function public.reengagement_due(
  p_quiet_days integer default 21,   -- how long away counts as "away"
  p_gap_days   integer default 30,   -- minimum spacing between two nudges
  p_max        integer default 3,    -- hard cap per absence
  p_limit      integer default 100   -- Expo takes 100 messages per request
)
returns table (
  user_id    uuid,
  token      text,
  system_key text,
  system_n   integer,
  push_body  text
)
language sql
stable
security definer
set search_path = public
as $$
  with eligible as (
    select
      p.id,
      p.last_seen_at,
      -- The cap counts nudges in the CURRENT absence, so it has to forget the
      -- last one once they come back. Nothing resets it: being seen AFTER the
      -- last nudge is itself the reset, computed here every run. That way no
      -- client write is trusted and no trigger fires on the heartbeat.
      --
      -- The null check is load-bearing. Written as coalesce(reengage_last_at,
      -- '-infinity') the comparison is true for ANY account never nudged, so a
      -- non-zero count sitting next to a null timestamp read as zero and the cap
      -- silently disappeared. That pairing should be unreachable — the sender
      -- always writes both — but a cap that depends on unreachable states being
      -- unreachable is not a cap. A test caught this.
      case
        when p.reengage_last_at is not null and p.last_seen_at > p.reengage_last_at
        then 0 else p.reengage_count
      end as sent_this_absence,
      t.token
      from public.profiles p
      join public.push_tokens t on t.user_id = p.id
     where p.reengage_opt_in = true
       and coalesce(p.is_minor, false) = false
       and coalesce(p.hidden, false) = false
       and p.delete_requested_at is null
       and p.last_seen_at is not null
       and p.last_seen_at < now() - make_interval(days => p_quiet_days)
       -- Never twice inside the gap.
       and (p.reengage_last_at is null
            or p.reengage_last_at < now() - make_interval(days => p_gap_days))
  ),
  capped as (
    select * from eligible where sent_this_absence < p_max
  ),
  facts as (
    select
      e.*,
      coalesce((select a.balance_cents
                  from public.ledger_accounts a
                 where a.user_id = e.id and a.kind = 'earnings'), 0) as cents,
      (select count(*) from public.follows f
        where f.following_id = e.id and f.created_at > e.last_seen_at)  as new_followers,
      (select count(*) from public.notifications n
        where n.user_id = e.id and n.read = false and n.type <> 'system') as unread,
      (select count(*) from public.posts po
        where po.user_id = e.id and po.archived_at is null)             as posts,
      (select p2.badge_tier from public.profiles p2 where p2.id = e.id) as tier,
      -- Every message already heard DURING THIS ABSENCE, read back off the rows
      -- that were sent. Remembering only the previous key was not enough: with
      -- two messages true of the same account it alternated A, B, A, B forever.
      -- Bounded by created_at > last_seen_at, so coming back clears the slate.
      (select coalesce(array_agg(distinct n.system_key), '{}'::text[])
         from public.notifications n
        where n.user_id = e.id and n.type = 'system'
          and n.created_at > e.last_seen_at)                            as heard
      from capped e
  ),
  chosen as (
    select
      f.id,
      f.token,
      -- Priority, most specific first. The generic message is the last resort,
      -- never the opener. A key already heard this absence is skipped outright,
      -- so three nudges are three different things to say — and when there is
      -- nothing new to say, the answer is silence, not a repeat.
      (case
        when f.cents > 0          and not ('earnings'    = any (f.heard)) then 'earnings'
        when f.new_followers > 0  and not ('followers'   = any (f.heard)) then 'followers'
        when f.unread > 0         and not ('unread'      = any (f.heard)) then 'unread'
        when f.posts = 0          and not ('first_post'  = any (f.heard)) then 'first_post'
        when f.tier is null and f.posts > 0
                                  and not ('badge_first' = any (f.heard)) then 'badge_first'
        when not ('back' = any (f.heard))                                 then 'back'
        else null   -- they have heard everything true of them; stay quiet
      end) as k,
      f.new_followers,
      f.unread
      from facts f
  )
  select
    c.id,
    c.token,
    c.k,
    case c.k when 'followers' then c.new_followers::int
             when 'unread'    then c.unread::int
             else null end,
    -- The push body, in English. Every push this app sends is English already
    -- (see supabase/functions/send-push/index.ts, which has one hardcoded
    -- string per action), so this matches the app rather than inventing a
    -- second, translated push path. The IN-APP row is properly localised: it
    -- renders from system_key through lib/i18n.ts in all ten languages.
    case c.k
      when 'earnings'    then 'You have earnings waiting in your Laybell wallet.'
      when 'followers'   then case when c.new_followers = 1
                                   then 'Someone followed you while you were away.'
                                   else c.new_followers || ' people followed you while you were away.' end
      when 'unread'      then case when c.unread = 1
                                   then 'You have an unread notification on Laybell.'
                                   else 'You have ' || c.unread || ' unread notifications on Laybell.' end
      when 'first_post'  then 'Your Laybell profile is still empty. Share your first track.'
      when 'badge_first' then 'Keep posting on Laybell to earn your first badge.'
      when 'back'        then 'Your listeners are still here. Come share something new.'
    end
    from chosen c
   where c.k is not null
   order by c.id
   limit p_limit;
$$;

comment on function public.reengagement_due is
  'Read-only: who is due a re-engagement nudge and what it would say. Sends nothing. Call this to inspect before trusting send_reengagement_nudges().';

-- 4) The sender ──────────────────────────────────────────────────────────────
-- Needs pg_net to reach Expo. Nothing else in this database makes an outbound
-- request, so this is the extension's only caller.
create extension if not exists pg_net with schema extensions;

create or replace function public.send_reengagement_nudges()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows     jsonb;
  v_n        integer;
  v_messages jsonb;
begin
  -- Freeze the candidate set once: the same rows drive the notification insert,
  -- the bookkeeping and the push, so they cannot disagree.
  select coalesce(jsonb_agg(to_jsonb(d)), '[]'::jsonb) into v_rows
    from public.reengagement_due() d;

  v_n := jsonb_array_length(v_rows);
  if v_n = 0 then return 0; end if;

  -- The in-app row. This is the part that must not be lost: the push is a
  -- knock on the door, the row is what they find when they open it.
  insert into public.notifications (user_id, actor_id, type, system_key, system_n, read)
  select (r->>'user_id')::uuid, null, 'system', r->>'system_key',
         nullif(r->>'system_n', '')::int, false
    from jsonb_array_elements(v_rows) r;

  update public.profiles p
     set reengage_last_at = now(),
         -- Same self-resetting count as reengagement_due(), including the null
         -- check: seen after the last nudge means this absence is new, so it
         -- starts at one rather than carrying the previous absence forward.
         reengage_count   = case
                              when p.reengage_last_at is not null
                               and p.last_seen_at > p.reengage_last_at
                              then 1 else p.reengage_count + 1
                            end
    from jsonb_array_elements(v_rows) r
   where p.id = (r->>'user_id')::uuid;

  -- One batched request rather than a request per person. Expo caps a batch at
  -- 100, which is why reengagement_due() has the same limit.
  select jsonb_agg(jsonb_build_object(
           'to',    r->>'token',
           'title', 'Laybell',
           'body',  r->>'push_body',
           'sound', 'default',
           'data',  jsonb_build_object('type', 'system', 'key', r->>'system_key')
         ))
    into v_messages
    from jsonb_array_elements(v_rows) r;

  -- pg_net is async: this queues the request and returns immediately. The
  -- response lands in net._http_response, which is where to look when a run
  -- inserted rows but nobody's phone lit up.
  perform net.http_post(
    url     := 'https://exp.host/--/api/v2/push/send',
    body    := v_messages,
    headers := jsonb_build_object('Content-Type', 'application/json')
  );

  return v_n;
exception when others then
  -- Never let a bad run poison the hourly cron, but never swallow it silently
  -- either — the pattern that once had pg_cron reporting success hourly while
  -- deleting nothing. This raises a warning AND re-raises, so the job fails
  -- loudly in cron.job_run_details.
  raise warning 'send_reengagement_nudges failed: %', sqlerrm;
  raise;
end;
$$;

-- Neither function is for the app to call. `revoke from public` does NOT cover
-- anon or authenticated on Supabase — they must be named.
revoke all on function public.reengagement_due(integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.send_reengagement_nudges()                          from public, anon, authenticated;

-- 5) The schedule ────────────────────────────────────────────────────────────
-- 17:00 UTC = 1pm Eastern / 10am Pacific. Laybell is US-only, and no timezone
-- is stored per account, so a fixed daytime hour is the whole quiet-hours
-- policy. A push at 4am is how an app gets deleted.
select cron.unschedule('send-reengagement-nudges')
 where exists (select 1 from cron.job where jobname = 'send-reengagement-nudges');

select cron.schedule('send-reengagement-nudges', '0 17 * * *',
                     $$select public.send_reengagement_nudges();$$);

-- ─── Verify ─────────────────────────────────────────────────────────────────
select
  (select count(*) from public.profiles where reengage_opt_in)        as opted_in,
  (select count(*) from public.reengagement_due())                    as due_today,
  (select count(*) from cron.job where jobname = 'send-reengagement-nudges'
                                   and active)                        as job_scheduled_want_1,
  (select installed_version is not null from pg_available_extensions
    where name = 'pg_net')                                            as pg_net_want_true;
