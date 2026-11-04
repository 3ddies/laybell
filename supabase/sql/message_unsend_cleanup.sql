-- Cleanup: remove orphaned DM "unsend" tombstone objects (2026-11-04).
--
-- Background: a tombstone-based unsend was tried on 2026-11-01 and REJECTED; the app
-- reverted to Instagram-style hard-delete (lib/messageActions.unsendMessage does a plain
-- messages.delete() — see message_unsend.sql for the KEEPERS: `replica identity full`
-- and the message_hides table). Two objects from the rejected attempt were pushed to
-- production and never removed, and no longer exist anywhere in the repo:
--   • public.messages.unsent_at   (column)
--   • public.unsend_message(...)  (RPC)
-- Both were verified present in prod and unreferenced by the repo before writing this.
-- Dropping them removes the drift; the keepers above are intentionally left untouched.

alter table public.messages drop column if exists unsent_at;
drop function if exists public.unsend_message;
