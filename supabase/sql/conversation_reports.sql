-- Group-chat reporting — backs the "Report" action in the group chat's 3-dot
-- menu (lib/groups.ts reportConversation). Mirrors user_reports/post_reports.
-- Run in the Supabase Dashboard → SQL Editor. Until applied, the report insert
-- silently no-ops, so the app keeps working either way.

create table if not exists public.conversation_reports (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  reporter_id     uuid references auth.users(id) on delete set null,
  reason          text not null default 'other',
  created_at      timestamptz not null default now()
);

create index if not exists conversation_reports_conversation_idx
  on public.conversation_reports(conversation_id);

alter table public.conversation_reports enable row level security;

-- Any signed-in user can file a report (and only as themselves).
drop policy if exists "Users can file conversation reports" on public.conversation_reports;
create policy "Users can file conversation reports"
  on public.conversation_reports for insert
  with check (auth.uid() = reporter_id);

-- A user can see the reports they filed.
drop policy if exists "Users can view own conversation reports" on public.conversation_reports;
create policy "Users can view own conversation reports"
  on public.conversation_reports for select
  using (auth.uid() = reporter_id);
