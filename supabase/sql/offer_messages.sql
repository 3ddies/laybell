-- Buy-offers as their own notification type.
-- Run AFTER tagged_mentions.sql (which last set this constraint). Idempotent.
--
-- An offer is the one shop event still waiting on the seller, so it earns a push
-- of its own rather than riding the generic 'message' type. The copy for it lives
-- in supabase/functions/send-push and names the SENDER ONLY — never the amount.
-- What someone will pay for a beat is between the two of them, and a lock screen
-- is read by whoever happens to be holding the phone. The figure is on the offer
-- card inside the thread, which is also the only place it can be answered.
--
-- NOTE: send-push rejects any type not in its own ACTIONS map, and requires a
-- matching notifications row to already exist. So this constraint and that map
-- have to be changed together — a type in one and not the other silently drops
-- the push. **Redeploy send-push after running this.**

do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'notifications') then
    raise exception 'run the notifications migration first';
  end if;
end $$;

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('like','comment','follow','friend','message','mention','song_used','song_story','tag','offer'));

-- ── Checking it ───────────────────────────────────────────────────────────────
--   The constraint now admits 'offer':
--     select pg_get_constraintdef(oid) from pg_constraint
--      where conname = 'notifications_type_check';
--
--   Offers that have gone out (should match the offer orders that exist):
--     select n.created_at, p.username as from_user
--       from public.notifications n
--       join public.profiles p on p.id = n.actor_id
--      where n.type = 'offer' order by n.created_at desc limit 20;
