-- ───────────────────────────────────────────────────────────────────────────
-- Studio session invites in DMs — notification type.
--
-- The invite itself needs NO schema: it rides inside the message body as
-- `laybell://studio?session=…&code=…` (lib/studioInvite.ts), the same trick
-- offers, attachments and shared posts use. The only database change is
-- admitting the new notification type.
--
-- ⚠️ THIS PAIRS WITH A FUNCTION DEPLOY, AND EITHER ONE ALONE FAILS SILENTLY:
--
--     supabase functions deploy send-push
--
-- Without this SQL, createNotification's insert is rejected by the CHECK
-- constraint and the recipient gets nothing. Without the deploy, the row is
-- written but send-push falls through to its generic "interacted with you"
-- copy. Neither surfaces an error in the app. Do both.
--
-- SAFE TO RE-RUN.
-- ───────────────────────────────────────────────────────────────────────────

do $$
begin
  if to_regclass('public.notifications') is null then
    raise exception 'run the notifications migration first';
  end if;
end $$;

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('like','comment','follow','friend','message','mention','song_used','song_story','tag','offer','studio_invite'));

-- ── Checking it ───────────────────────────────────────────────────────────────
--   The constraint admits both 'offer' and 'studio_invite' — re-running this
--   after offer_messages.sql must not have dropped the former:
--
--     select pg_get_constraintdef(oid) from pg_constraint
--      where conname = 'notifications_type_check';
--
--   Expect a list containing BOTH. If 'offer' is missing, offer pushes are now
--   broken and this file was edited wrongly.
