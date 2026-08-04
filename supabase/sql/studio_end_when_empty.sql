-- ───────────────────────────────────────────────────────────────────────────
-- A studio session dies when the last participant leaves, and the invite card
-- in DMs can actually SEE that.
--
-- Two gaps this closes:
--
--  1. studio_host_exit() already ends a room when the HOST is the last one out.
--     A non-host leaving went through a bare delete on studio_session_members,
--     so a room could reach zero members and stay `status = 'open'` forever —
--     an empty session still advertising a Join.
--
--  2. The invite card could not observe the result. studio_sessions has
--     deliberately NO public SELECT policy (join_code is the room credential),
--     so the invitee — who by definition is not a member yet — always read
--     "no row", which the card must treat as open. Ending the session server
--     side was therefore invisible to exactly the person holding the invite.
--
-- Both new functions are SECURITY DEFINER for the same reason studio_host_exit
-- is: `status` and `host_id` are not client-writable, and the status read has to
-- cross the RLS boundary on purpose.
--
-- Idempotent and safe to re-run.
-- ───────────────────────────────────────────────────────────────────────────

-- ── 1. Leave, and close the room behind you if you were the last one ─────────
create or replace function public.studio_leave(p_session uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_host      uuid;
  v_status    text;
  v_remaining integer;
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

  -- The HOST leaving is a different operation: it has to hand the room over to
  -- the earliest remaining member rather than abandon it ownerless. Bounce the
  -- caller to studio_host_exit() instead of doing the wrong thing quietly.
  if v_host = v_uid then
    return 'is_host';
  end if;

  delete from public.studio_session_members
   where session_id = p_session and user_id = v_uid;

  select count(*) into v_remaining
    from public.studio_session_members
   where session_id = p_session;

  if v_remaining > 0 then
    return 'left';
  end if;

  -- Nobody left. Close it — and drop any broadcast with it, so an empty room
  -- can never stay on air. Already-ended rooms fall through unchanged.
  if v_status = 'open' then
    update public.studio_sessions
       set status = 'ended', ended_at = now(), live = false
     where id = p_session;
  end if;
  return 'ended';
end $$;

-- `revoke ... from public` is NOT enough on Supabase: ALTER DEFAULT PRIVILEGES
-- grants EXECUTE on every new function in `public` to anon/authenticated/
-- service_role, and the PUBLIC pseudo-role is not the `anon` role — so a
-- signed-out caller keeps EXECUTE unless anon is revoked by name. Verified
-- against the live ACL, which showed anon=X on both of these.
revoke all on function public.studio_leave(uuid) from public;
revoke execute on function public.studio_leave(uuid) from anon;
grant execute on function public.studio_leave(uuid) to authenticated;


-- ── 2. Status read for the invite card ───────────────────────────────────────
-- Returns 'open' / 'ended', or NULL when the session no longer exists.
--
-- This crosses RLS deliberately, and exposes ONLY the status — never join_code,
-- host_id, or the title. Knowing that a session id you were already handed is
-- over is not a leak; being unable to know it is the bug. The join code remains
-- the sole capability for actually entering the room.
create or replace function public.studio_session_status(p_session uuid)
returns text
language sql
security definer
stable
set search_path = public
as $$
  select status from public.studio_sessions where id = p_session;
$$;

-- Anon by name (see the note above). It matters more here than on
-- studio_leave: that one raises not_authenticated on its first line, whereas
-- this is a bare SELECT with no auth check, so leaving anon with EXECUTE would
-- let a signed-out caller probe any session id it already knew.
revoke all on function public.studio_session_status(uuid) from public;
revoke execute on function public.studio_session_status(uuid) from anon;
grant execute on function public.studio_session_status(uuid) to authenticated;


-- Verify: both should come back with security_definer = true.
select p.proname, p.prosecdef as security_definer
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('studio_leave', 'studio_session_status')
 order by p.proname;
