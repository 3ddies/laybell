-- Let a user delete their OWN messages (backs the GIF sheet's "Delete GIF" and any
-- future message deletion). Covers both 1:1 and group messages — they share the
-- `messages` table, and authorship is always `sender_id`. Run manually in the
-- Supabase SQL editor. Until applied, delete calls are silently denied by RLS and
-- the message reappears on the next reload.

drop policy if exists "Senders can delete their own messages" on public.messages;
create policy "Senders can delete their own messages"
  on public.messages for delete
  using (auth.uid() = sender_id);
