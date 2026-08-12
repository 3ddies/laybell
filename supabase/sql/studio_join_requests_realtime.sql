-- Hand-raise (audience → seat in a studio session) never worked, and this is why.
--
-- BOTH ends of the flow listen to postgres_changes on studio_join_requests:
--   · the HOST subscribes to see a raised hand arrive (app/studio/[id].tsx)
--   · the LISTENER subscribes to their OWN row, so being accepted hops them
--     straight into the room (app/studio/listen/[id].tsx)
-- and the table was never added to the `supabase_realtime` publication, so
-- Postgres never sends those changes to anyone. The request row is written
-- correctly, RLS lets the host read it, and nothing ever tells either side.
--
-- studio_live.sql set `replica identity full` on this table — which is only
-- needed FOR realtime — so the intent was there and just this step was missed.
-- It is easy to miss because no other table in this project is enabled from
-- SQL: messages, comments and live_streams were all switched on by hand in the
-- Supabase dashboard, so there was no existing line here to copy.
--
-- Safe to run more than once: adding a table already in the publication is an
-- error, so this checks first.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'studio_join_requests'
  ) then
    execute 'alter publication supabase_realtime add table public.studio_join_requests';
    raise notice 'studio_join_requests added to supabase_realtime';
  else
    raise notice 'studio_join_requests was already in supabase_realtime - nothing to do';
  end if;
end $$;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- Expect exactly one row. No row means the publication change did not take and
-- hand-raise will still be silent.
select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
  and schemaname = 'public'
  and tablename = 'studio_join_requests';
