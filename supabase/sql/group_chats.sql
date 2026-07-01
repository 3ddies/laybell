-- Group chats — a conversations model that lives ALONGSIDE the existing 1:1 DMs.
-- 1:1 DMs are untouched (they keep using messages.sender_id/receiver_id with a
-- null conversation_id). Group messages reuse the same messages table with a
-- conversation_id set and a null receiver_id — so message_reactions (which keys
-- off messages.id) works for group messages for free.
--
-- Run manually in the Supabase Dashboard → SQL Editor, AFTER message_reactions.sql
-- (this file upgrades those reaction policies to also cover group members).

create extension if not exists pgcrypto; -- gen_random_uuid()

-- 1) Conversations + membership --------------------------------------------------

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  title text,
  avatar_url text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  -- Bumped whenever a message lands, so threads sort by latest activity.
  updated_at timestamptz not null default now()
);

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  added_by uuid references auth.users(id) on delete set null,
  joined_at timestamptz not null default now(),
  last_read_at timestamptz,
  primary key (conversation_id, user_id)
);
create index if not exists conversation_members_user_idx on public.conversation_members(user_id);

-- Membership check as SECURITY DEFINER: lets the conversations/members/messages
-- policies test membership WITHOUT the policy re-entering conversation_members'
-- own RLS (which would recurse infinitely).
create or replace function public.is_conversation_member(conv uuid, uid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.conversation_members m
    where m.conversation_id = conv and m.user_id = uid
  );
$$;

-- 2) Messages gains an optional conversation_id ---------------------------------

alter table public.messages
  add column if not exists conversation_id uuid references public.conversations(id) on delete cascade;
-- Group messages have no single recipient.
alter table public.messages alter column receiver_id drop not null;
create index if not exists messages_conversation_idx on public.messages(conversation_id, created_at);

-- Keep conversations.updated_at fresh on every new group message.
create or replace function public.bump_conversation_updated()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.conversation_id is not null then
    update public.conversations set updated_at = now() where id = new.conversation_id;
  end if;
  return new;
end; $$;
drop trigger if exists messages_bump_conversation on public.messages;
create trigger messages_bump_conversation after insert on public.messages
  for each row execute function public.bump_conversation_updated();

-- 3) RLS -------------------------------------------------------------------------

alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;

-- Conversations: members see it; anyone may create one (as themselves); members
-- may rename it / set its avatar. The creator is included explicitly so the
-- INSERT ... RETURNING at create time (before their membership row exists) can
-- read the new row back, and so an empty group still shows for its creator.
drop policy if exists "Members can view conversations" on public.conversations;
create policy "Members can view conversations" on public.conversations for select
  using (public.is_conversation_member(id, auth.uid()) or created_by = auth.uid());
drop policy if exists "Users can create conversations" on public.conversations;
create policy "Users can create conversations" on public.conversations for insert
  with check (auth.uid() = created_by);
drop policy if exists "Members can update conversations" on public.conversations;
create policy "Members can update conversations" on public.conversations for update
  using (public.is_conversation_member(id, auth.uid()))
  with check (public.is_conversation_member(id, auth.uid()));

-- Members: you see the roster of groups you're in; the creator or an existing
-- member can add people (added_by must be you); you can remove yourself (leave);
-- you can update your own row (last_read_at).
drop policy if exists "Members can view roster" on public.conversation_members;
create policy "Members can view roster" on public.conversation_members for select
  using (public.is_conversation_member(conversation_id, auth.uid()));
drop policy if exists "Creator or members can add" on public.conversation_members;
create policy "Creator or members can add" on public.conversation_members for insert
  with check (
    auth.uid() = added_by
    and (
      exists (select 1 from public.conversations c where c.id = conversation_id and c.created_by = auth.uid())
      or public.is_conversation_member(conversation_id, auth.uid())
    )
  );
drop policy if exists "Members can update their read state" on public.conversation_members;
create policy "Members can update their read state" on public.conversation_members for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Users can leave" on public.conversation_members;
create policy "Users can leave" on public.conversation_members for delete
  using (auth.uid() = user_id);

-- Messages: ADDITIVE group policies. Existing 1:1 DM policies are left untouched;
-- because RLS policies OR together, these only widen access to group messages.
drop policy if exists "Members can read group messages" on public.messages;
create policy "Members can read group messages" on public.messages for select
  using (conversation_id is not null and public.is_conversation_member(conversation_id, auth.uid()));
drop policy if exists "Members can send group messages" on public.messages;
create policy "Members can send group messages" on public.messages for insert
  with check (
    conversation_id is not null
    and auth.uid() = sender_id
    and public.is_conversation_member(conversation_id, auth.uid())
  );

-- 4) Upgrade message_reactions policies to also cover group members --------------
--    (they were DM-only: sender_id/receiver_id checks. Requires the table from
--     message_reactions.sql to already exist.)
drop policy if exists "Participants can react to messages" on public.message_reactions;
create policy "Participants can react to messages" on public.message_reactions for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.messages m
      where m.id = message_id
        and (
          m.sender_id = auth.uid()
          or m.receiver_id = auth.uid()
          or public.is_conversation_member(m.conversation_id, auth.uid())
        )
    )
  );
drop policy if exists "Participants can view message reactions" on public.message_reactions;
create policy "Participants can view message reactions" on public.message_reactions for select
  using (
    exists (
      select 1 from public.messages m
      where m.id = message_id
        and (
          m.sender_id = auth.uid()
          or m.receiver_id = auth.uid()
          or public.is_conversation_member(m.conversation_id, auth.uid())
        )
    )
  );

-- 5) Realtime — emit full rows so deletes carry their keys.
alter table public.conversations replica identity full;
alter table public.conversation_members replica identity full;
