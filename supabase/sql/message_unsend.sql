-- DM unsend + delete-for-you (2026-09-26).
--
-- UNSEND = hard-delete your own message (Instagram-style: it vanishes for everyone,
-- no tombstone). The sender-delete RLS policy already exists (message_delete.sql);
-- the only missing piece is the OTHER side hearing the delete LIVE. A realtime
-- DELETE payload carries only the primary key by default, so it can't be filtered
-- by receiver/conversation the way the INSERT subscription is. Set the replica
-- identity to FULL so receiver_id / conversation_id ride along in the delete payload
-- and each thread's DELETE subscription can filter to its own messages.
alter table public.messages replica identity full;

-- DELETE FOR YOU = hide a message from ONE user; the other side keeps it. A tiny
-- per-user join table, filtered client-side on load + on realtime inserts.
create table if not exists public.message_hides (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

alter table public.message_hides enable row level security;

-- Each user only ever sees / adds / removes their OWN hides. Hiding a message you
-- can't see is harmless (it only affects your own client-side filter), so the
-- insert check is just ownership of the hide row, not membership in the thread.
drop policy if exists "Users read their own message hides" on public.message_hides;
create policy "Users read their own message hides"
  on public.message_hides for select using (auth.uid() = user_id);

drop policy if exists "Users add their own message hides" on public.message_hides;
create policy "Users add their own message hides"
  on public.message_hides for insert with check (auth.uid() = user_id);

drop policy if exists "Users remove their own message hides" on public.message_hides;
create policy "Users remove their own message hides"
  on public.message_hides for delete using (auth.uid() = user_id);
