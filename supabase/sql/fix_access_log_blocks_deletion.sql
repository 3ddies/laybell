-- Account deletion blocker #2: access_log's append-only trigger.  2026-08-21.
--
--   npx supabase db query --linked -f supabase/sql/fix_access_log_blocks_deletion.sql
--
-- FOUND by probing the real delete after fix_follow_events_blocks_deletion.sql
-- landed. The follow_events bug was genuinely fixed; this was the NEXT one behind it:
--
--   DELETE FAILED [P0001] access_log is append-only (attempted UPDATE)
--
-- THE MECHANISM
-- `access_log.user_id` is `references auth.users(id) ON DELETE SET NULL`, and
-- **SET NULL is an UPDATE**. `access_log_no_update` is a BEFORE UPDATE trigger that
-- raises on any UPDATE. So deleting a user makes Postgres attempt the anonymising
-- update, the trigger refuses it, and the entire account deletion aborts.
--
-- Both halves were deliberate and both are right on their own terms: severing
-- user_id rather than deleting the row is correct (the security-evidence log should
-- outlive the account), and refusing UPDATE is correct (evidence you can quietly
-- edit is not evidence). They were simply never exercised together — the same
-- reason the follow_events bug survived: production had no account pending deletion.
--
-- THE FIX: permit exactly ONE update — the FK's anonymisation — and only when it
-- changes nothing else. user_id may go non-null -> null; every other column must be
-- byte-identical. Any other UPDATE still raises exactly as before, so the
-- evidentiary guarantee is unchanged: you can sever the link to a deleted account,
-- you cannot alter what the row says happened.
create or replace function public.access_log_immutable()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and old.user_id is not null
     and new.user_id is null
     and new.id           is not distinct from old.id
     and new.event        is not distinct from old.event
     and new.subject_type is not distinct from old.subject_type
     and new.subject_id   is not distinct from old.subject_id
     and new.ip           is not distinct from old.ip
     and new.ip_source    is not distinct from old.ip_source
     and new.user_agent   is not distinct from old.user_agent
     and new.created_at   is not distinct from old.created_at
  then
    return new;   -- the ON DELETE SET NULL anonymisation, and nothing else
  end if;
  raise exception 'access_log is append-only (attempted %)', tg_op;
end $$;

-- DELETE stays unblocked, as before — retention pruning depends on it.
