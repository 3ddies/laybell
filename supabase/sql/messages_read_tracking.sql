-- Unread message tracking — Supabase
-- Run in the Supabase Dashboard → SQL Editor (anon key cannot alter schema/policies).

-- 1) Add a read flag to messages (defaults to unread).
alter table public.messages
  add column if not exists read boolean not null default false;

-- 2) Allow the recipient to mark their received messages as read.
--    (Skip if you already have an UPDATE policy covering receiver_id = auth.uid().)
create policy "Recipients can mark messages read"
on public.messages for update
using (auth.uid() = receiver_id)
with check (auth.uid() = receiver_id);

-- After this:
--   - The home header shows a badge counting messages where
--     receiver_id = me AND read = false.
--   - Opening a conversation marks that sender's messages as read.
