-- ───────────────────────────────────────────────────────────────────────────
-- Host leaves a studio session: kill the broadcast, hand over or end.
--
-- Before this, leaveSession() only deleted the membership row. A HOST doing that
-- left the session `open` with `host_id` pointing at someone who had gone — and
-- if they were broadcasting, `live` stayed true. Listeners kept seeing a live
-- strip for a room whose host had walked away, and the host had no idea they
-- were still on air. That is the stale-session case this closes.
--
-- Rules, in order:
--   1. The broadcast ALWAYS stops. A host cannot leave a session still live —
--      whoever inherits it can choose to go live again deliberately.
--   2. If other members remain, ownership passes to the EARLIEST joiner (the
--      most-invested participant, and a stable, non-arbitrary choice).
--   3. If nobody remains, the session ends.
--
-- SECURITY DEFINER because host_id is not client-writable: letting a client set
-- it directly would let anyone claim any room.
--
-- Idempotent and safe to re-run.
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.studio_host_exit(p_session uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_host      uuid;
  v_status    text;
  v_successor uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select host_id, status into v_host, v_status
    from public.studio_sessions
   where id = p_session
   for update;                       -- serialize concurrent exits

  if v_host is null then
    return 'not_found';
  end if;

  -- Not the host: an ordinary leave, handled by the caller's delete.
  if v_host <> v_uid then
    return 'not_host';
  end if;

  if v_status <> 'open' then
    return 'already_closed';
  end if;

  -- 1) The broadcast stops no matter which branch we take below.
  update public.studio_sessions set live = false where id = p_session;

  -- 2) Earliest remaining member (excluding the departing host) inherits.
  select m.user_id into v_successor
    from public.studio_session_members m
   where m.session_id = p_session
     and m.user_id <> v_uid
   order by m.joined_at asc
   limit 1;

  -- The host's own membership goes either way.
  delete from public.studio_session_members
   where session_id = p_session and user_id = v_uid;

  if v_successor is not null then
    update public.studio_sessions
       set host_id = v_successor
     where id = p_session;
    update public.studio_session_members
       set role = 'host'
     where session_id = p_session and user_id = v_successor;
    return 'handed_over';
  end if;

  -- 3) Nobody left — close it rather than leave an ownerless open room.
  update public.studio_sessions
     set status = 'ended', ended_at = now()
   where id = p_session;
  return 'ended';
end $$;

revoke all on function public.studio_host_exit(uuid) from public;
grant execute on function public.studio_host_exit(uuid) to authenticated;

-- Verify: should return the function with security definer set.
select p.proname, p.prosecdef as security_definer
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'studio_host_exit';
