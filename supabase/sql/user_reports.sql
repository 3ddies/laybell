-- User reporting — Supabase table + RLS
-- Run in the Supabase Dashboard → SQL Editor (anon key cannot create tables).
--
-- Backs the "Report user" action in lib/postActions.ts (the 3-dot menu on other
-- people's profiles, posts and stories). Until this is applied the report insert
-- silently no-ops, so the app keeps working either way.

create table if not exists public.user_reports (
  id          uuid primary key default gen_random_uuid(),
  reported_id uuid not null references auth.users(id) on delete cascade,
  reporter_id uuid references auth.users(id) on delete set null,
  reason      text not null default 'other',
  created_at  timestamptz not null default now()
);

create index if not exists user_reports_reported_id_idx on public.user_reports(reported_id);

alter table public.user_reports enable row level security;

-- Any signed-in user can file a report (and only as themselves).
create policy "Users can file user reports"
on public.user_reports for insert
with check (auth.uid() = reporter_id);

-- A user can see the reports they filed.
create policy "Users can view own user reports"
on public.user_reports for select
using (auth.uid() = reporter_id);
