-- ───────────────────────────────────────────────────────────────────────────
-- The check-in that keeps a studio session alive.
--
-- MUST be deployed alongside live_ghost_sweeper.sql — the sweeper ends anything
-- that stops checking in, so without this every real session would be reaped
-- ~90 seconds after it started.
--
-- An RPC rather than a direct update because studio_sessions is not
-- client-writable (join_code is the room credential and status/host_id are
-- guarded). SECURITY DEFINER, but it can only ever stamp timestamps, and only
-- for the caller's own row.
--
-- Split responsibilities:
--   • EVERY member stamps their own membership — that's what stops the sweeper
--     dropping them and collapsing the room to empty.
--   • Only the HOST stamps the session — `live` means "the host is broadcasting",
--     so a listener's phone must not be able to keep an abandoned broadcast on
--     air. If the host's device dies, the flag drops and the session stays open
--     for whoever is still in the room.
--
-- Idempotent; safe to re-run.
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.studio_heartbeat(p_session uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return; end if;

  update public.studio_session_members
     set last_seen_at = now()
   where session_id = p_session
     and user_id = v_uid;

  -- Host only (see the header).
  update public.studio_sessions
     set last_heartbeat_at = now()
   where id = p_session
     and host_id = v_uid;
end $$;

revoke all on function public.studio_heartbeat(uuid) from public;
-- anon by name: Supabase's default privileges grant EXECUTE on every new public
-- function to anon, and revoking from PUBLIC does not cover the anon ROLE.
revoke execute on function public.studio_heartbeat(uuid) from anon;
grant execute on function public.studio_heartbeat(uuid) to authenticated;

-- Seed existing rows so the sweeper's first pass doesn't reap a session that is
-- genuinely running right now but has never had a chance to ping.
update public.studio_session_members set last_seen_at = now() where last_seen_at is null;
update public.studio_sessions set last_heartbeat_at = now() where live = true and last_heartbeat_at is null;

select p.proname, p.prosecdef as security_definer,
       array_to_string(p.proacl::text[], ' | ') as acl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'studio_heartbeat';
