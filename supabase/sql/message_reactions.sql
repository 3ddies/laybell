-- Message reactions — press-and-hold a DM bubble to react with an emoji
-- (iMessage-style tapbacks). One reaction per user per message; re-reacting
-- swaps the emoji, reacting with the same emoji again removes it.
-- Run manually in the Supabase Dashboard → SQL Editor (anon key cannot alter
-- schema/policies).

create table if not exists public.message_reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  -- One row per (message, user): an upsert on this key swaps the chosen emoji.
  primary key (message_id, user_id)
);

create index if not exists message_reactions_message_idx
  on public.message_reactions (message_id);

alter table public.message_reactions enable row level security;

-- A participant of the underlying message (its sender OR receiver) may add their
-- own reaction. The subquery also scopes realtime: postgres_changes only streams
-- rows the subscriber can SELECT, so a user only hears about reactions on their
-- own threads.
drop policy if exists "Participants can react to messages" on public.message_reactions;
create policy "Participants can react to messages"
  on public.message_reactions for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.messages m
      where m.id = message_id
        and (m.sender_id = auth.uid() or m.receiver_id = auth.uid())
    )
  );

-- Swap the emoji on an existing reaction (upsert path).
drop policy if exists "Users can change their reaction" on public.message_reactions;
create policy "Users can change their reaction"
  on public.message_reactions for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Remove your own reaction (toggle off).
drop policy if exists "Users can remove their reaction" on public.message_reactions;
create policy "Users can remove their reaction"
  on public.message_reactions for delete
  using (auth.uid() = user_id);

-- Either participant of the message can see all its reactions.
drop policy if exists "Participants can view message reactions" on public.message_reactions;
create policy "Participants can view message reactions"
  on public.message_reactions for select
  using (
    exists (
      select 1 from public.messages m
      where m.id = message_id
        and (m.sender_id = auth.uid() or m.receiver_id = auth.uid())
    )
  );

-- Emit full row on DELETE so the realtime "reaction removed" event carries the
-- primary key (message_id, user_id) instead of just replica-identity nulls.
alter table public.message_reactions replica identity full;
