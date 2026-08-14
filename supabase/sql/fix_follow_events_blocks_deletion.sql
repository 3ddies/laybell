-- Account deletion is broken: follow_events' FK aborts it.  NOT YET RUN.
--
--   npx supabase db query --linked -f supabase/sql/fix_follow_events_blocks_deletion.sql
--
-- FOUND 2026-08-14, by force-deleting one throwaway test account and watching it
-- fail with:
--
--   23503: insert or update on table "follow_events" violates foreign key
--   constraint "follow_events_follower_id_fkey"
--   DETAIL: Key (follower_id)=(...) is not present in table "users".
--   CONTEXT: PL/pgSQL function log_follow_event() line 8
--
-- THE MECHANISM
-- `follow_events.follower_id` and `.following_id` both reference auth.users.
-- `follows_log_delete` is an AFTER DELETE trigger on public.follows that INSERTS an
-- 'unfollow' row into follow_events.  Deleting an auth.users row cascades into
-- public.follows, which fires that trigger — and the trigger then tries to insert a
-- row pointing at the user that was just deleted.  The FK rejects it and the whole
-- delete aborts.
--
-- WHO THIS HITS: every account that has followed, or been followed by, anyone.  In
-- practice that is every real user.  The in-app flow still LOOKS fine, because
-- "Delete now" only flags the row and signs the user out; it is the hard delete 48
-- hours later that fails.  So the app tells the user their email frees up in 48
-- hours and it never does, and the Privacy Policy's deletion promise is not kept.
--
-- WHY NOTHING CAUGHT IT: production had ZERO accounts pending deletion until now,
-- so the failing path had never once executed.  Same shape as the hidden-profiles
-- RLS gap — no data in the failing state, therefore no symptom.

-- ── 1. The root cause ────────────────────────────────────────────────────────
-- Skip the log write when either party no longer exists.  That is only ever true
-- when this DELETE is the cascade from an account deletion rather than a real
-- unfollow: in a genuine unfollow both users are still present, so the log keeps
-- working exactly as before and follower-insights history is unaffected.
create or replace function public.log_follow_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.follow_events (follower_id, following_id, action)
      values (new.follower_id, new.following_id, 'follow');
    return new;
  elsif tg_op = 'DELETE' then
    if exists (select 1 from auth.users where id = old.follower_id)
       and exists (select 1 from auth.users where id = old.following_id) then
      insert into public.follow_events (follower_id, following_id, action)
        values (old.follower_id, old.following_id, 'unfollow');
    end if;
    return old;
  end if;
  return null;
end; $$;

-- ── 2. Defence in depth: one bad account must not abort the whole sweep ──────
-- sweep_deletable_accounts() loops `delete from auth.users` with NO exception
-- handling, inside a single transaction.  So ANY account that throws — this bug or
-- a future one — rolls back every other deletion in the same run.  One stuck
-- account silently stops deletion for everybody, indefinitely, and the hourly cron
-- keeps failing with nobody watching.  Skip-and-continue instead, and report how
-- many were skipped so it is visible rather than silent.
create or replace function public.sweep_deletable_accounts()
returns int
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_id      uuid;
  v_count   int := 0;
  v_skipped int := 0;
begin
  for v_id in
    select p.id
    from public.profiles p
    where
      (
        (p.delete_immediately = true and p.delete_requested_at <= now() - interval '48 hours')
        or (
          coalesce(p.delete_immediately, false) = false
          and p.delete_requested_at is not null
          and coalesce(p.last_seen_at, p.delete_requested_at) < now() - interval '3 months'
        )
      )
      and coalesce(p.legal_hold, false) = false
      and not exists (
        select 1 from public.posts x where x.user_id = p.id and coalesce(x.legal_hold, false) = true
      )
      and not exists (select 1 from public.user_reports ur where ur.reported_id = p.id and ur.resolved_at is null)
      and not exists (select 1 from public.post_reports pr where pr.reported_user_id = p.id and pr.resolved_at is null)
      and not exists (
        select 1 from public.post_reports pr
        join public.posts pp on pp.id = pr.post_id
        where pp.user_id = p.id and pr.resolved_at is null
      )
      and not exists (
        select 1 from public.ad_reports ar
        join public.ad_campaigns c on c.id = ar.campaign_id
        where c.user_id = p.id and ar.resolved_at is null
      )
  loop
    begin
      delete from auth.users where id = v_id;  -- cascades data + fires storage purge
      v_count := v_count + 1;
    exception when others then
      v_skipped := v_skipped + 1;
      raise warning 'sweep_deletable_accounts: skipped % — %', v_id, sqlerrm;
    end;
  end loop;
  if v_skipped > 0 then
    raise warning 'sweep_deletable_accounts: % deleted, % SKIPPED — investigate', v_count, v_skipped;
  end if;
  return v_count;
end;
$$;

revoke execute on function public.sweep_deletable_accounts() from public;

-- ── 3. Verify the real path, not a proxy ─────────────────────────────────────
-- Deletion cannot be proven by reading the function.  After running this, create a
-- throwaway account in the app, FOLLOW someone with it (that is the trigger for the
-- bug), delete it in-app, then force the sweep's own statement against it:
--
--   delete from auth.users where id = '<id>';
--
-- It must succeed WITHOUT deleting public.follows first.  That is the whole fix.
