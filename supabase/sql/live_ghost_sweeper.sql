-- ───────────────────────────────────────────────────────────────────────────
-- Nothing stays "live" after the broadcaster stops being there.
--
-- WHY CLIENT CLEANUP IS NOT ENOUGH. Ending a broadcast is a write the leaving
-- client has to make. Every way of leaving that ISN'T a deliberate tap skips it:
--   • force-quit from the app switcher     • crash / OOM kill
--   • battery dies                          • phone loses signal mid-broadcast
--   • iOS suspends the app in background    • laptop lid closes on the connector
-- endMyStaleLiveStreams() only reaps YOUR OWN leftovers, and only once your app
-- comes back — if the phone never comes back, neither does the cleanup, and the
-- row sits 'live' forever in everyone else's feed.
--
-- So the authority moves server-side: a pg_cron job that runs every minute and
-- ends anything whose owner has stopped checking in. It needs no client to be
-- alive, which is the whole point.
--
-- HEARTBEATS. A live host pings every ~15s (lib/live.beatLiveStream), and a
-- studio session now does the same (lib/studio.beatStudioSession). The grace
-- windows below are deliberately several missed beats wide — a lift, a tunnel
-- or a backgrounded app shouldn't kill a real session.
--
-- NULL HEARTBEAT IS NOT "FRESH". The existing client filter treats a NULL
-- last_heartbeat_at as always-fresh, which is exactly how a ghost survives
-- forever. Here NULL falls back to when the thing STARTED, so a row that never
-- pinged still ages out.
--
-- Idempotent; safe to re-run.
-- ───────────────────────────────────────────────────────────────────────────

-- Studio sessions get the same heartbeat livestreams already have.
alter table public.studio_sessions
  add column if not exists last_heartbeat_at timestamptz;

-- And membership gets one, so a force-killed participant stops propping a room
-- open. Without this, studio_leave() can never see the room reach zero.
alter table public.studio_session_members
  add column if not exists last_seen_at timestamptz;


create or replace function public.reap_stale_lives()
returns table (lives_ended int, broadcasts_stopped int, members_dropped int, sessions_closed int)
language plpgsql
security definer
set search_path = public
as $$
declare
  -- ~6 missed 15s beats. Long enough to ride out a dead spot, short enough that
  -- a ghost is gone well before anyone reports it.
  live_grace   constant interval := interval '90 seconds';
  -- Members get longer: dropping someone mid-session is more disruptive than a
  -- stale badge, and studio_leave() closes the room the moment it empties.
  member_grace constant interval := interval '150 seconds';
  v_lives int; v_broadcasts int; v_members int; v_sessions int;
begin
  -- 1) Livestreams whose host stopped pinging.
  with dead as (
    update public.live_streams
       set status = 'ended', ended_at = now()
     where status = 'live'
       and coalesce(last_heartbeat_at, started_at, created_at) < now() - live_grace
    returning 1
  ) select count(*)::int into v_lives from dead;

  -- 2) Studio sessions still flagged as broadcasting. The session may legitimately
  --    stay OPEN (people are in the room) — only the on-air flag drops.
  with dead as (
    update public.studio_sessions
       set live = false
     where live = true
       and coalesce(last_heartbeat_at, live_started_at, created_at) < now() - live_grace
    returning 1
  ) select count(*)::int into v_broadcasts from dead;

  -- 3) Participants who stopped checking in. This is what lets an abandoned room
  --    actually reach zero members.
  with gone as (
    delete from public.studio_session_members m
     using public.studio_sessions s
     where s.id = m.session_id
       and s.status = 'open'
       and coalesce(m.last_seen_at, m.joined_at) < now() - member_grace
    returning 1
  ) select count(*)::int into v_members from gone;

  -- 4) Any open session left with nobody in it is over — the same rule
  --    studio_leave() applies on a clean exit, now enforced regardless of how
  --    the last participant left.
  with closed as (
    update public.studio_sessions s
       set status = 'ended', ended_at = now(), live = false
     where s.status = 'open'
       and not exists (select 1 from public.studio_session_members m where m.session_id = s.id)
    returning 1
  ) select count(*)::int into v_sessions from closed;

  return query select v_lives, v_broadcasts, v_members, v_sessions;
end $$;

-- Server-side only. No client ever calls this; exposing it would let anyone
-- terminate broadcasts.
revoke all on function public.reap_stale_lives() from public;
revoke execute on function public.reap_stale_lives() from anon, authenticated;


-- Every minute, forever, with no client involved.
do $$
begin
  perform cron.unschedule('reap-stale-lives');
exception when others then null;   -- not scheduled yet
end $$;

select cron.schedule('reap-stale-lives', '* * * * *', 'select public.reap_stale_lives()');


-- Verify: the job should be listed and active.
select jobid, schedule, command, active from cron.job where jobname = 'reap-stale-lives';
