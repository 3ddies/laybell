-- The studio session screen subscribes to postgres_changes on TWO tables:
--
--   · studio_session_members — someone joined, left, or was removed
--   · studio_sessions        — the broadcast went live, or the session ended
--
-- Neither is in the `supabase_realtime` publication, so Postgres has never sent
-- those changes and NEITHER subscription has ever fired. The roster is fetched
-- once when the screen mounts and then never again for the life of the session.
--
-- What that looks like in use:
--   · a member who joins after you opened the screen never gains their avatar
--     (their name still arrives, because LiveKit carries it on the token)
--   · a member never sees the session go live, or end
--   · the seat count in the header goes stale
--
-- This is the same fault as studio_join_requests_realtime.sql, found the same
-- way: by asking the database which tables actually publish rather than reading
-- the client code and assuming. `replica identity full` is already set on these
-- from studio_live.sql — which is only ever needed FOR realtime, so the intent
-- was there and just this step was missed. Twice now.
--
-- The app also polls as a fallback (app/studio/[id].tsx), so this is not the
-- only thing standing between a member and their avatar — it is what makes it
-- immediate instead of up to twenty seconds late.
--
-- Safe to run more than once: adding a table already in the publication is an
-- error, so each is checked first.

do $$
declare
  t text;
begin
  foreach t in array array['studio_session_members', 'studio_sessions'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
      raise notice '% added to supabase_realtime', t;
    else
      raise notice '% was already in supabase_realtime - nothing to do', t;
    end if;
  end loop;
end $$;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- Expect THREE rows: the two above plus studio_join_requests. Fewer means the
-- publication change did not take and the roster will stay stale.
select tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
  and schemaname = 'public'
  and tablename like 'studio%'
order by tablename;
