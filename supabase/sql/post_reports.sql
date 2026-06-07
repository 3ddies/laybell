-- Post reporting — Supabase table + RLS
-- Run in the Supabase Dashboard → SQL Editor (anon key cannot create tables).
--
-- Backs the "Report post" action in lib/postActions.ts. Until this is applied
-- the report insert silently no-ops, so the app keeps working either way.

create table if not exists public.post_reports (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.posts(id) on delete cascade,
  reporter_id uuid references auth.users(id) on delete set null,
  reason      text not null default 'other',
  created_at  timestamptz not null default now()
);

create index if not exists post_reports_post_id_idx on public.post_reports(post_id);

alter table public.post_reports enable row level security;

-- Any signed-in user can file a report (and only as themselves).
create policy "Users can file reports"
on public.post_reports for insert
with check (auth.uid() = reporter_id);

-- A user can see the reports they filed.
create policy "Users can view own reports"
on public.post_reports for select
using (auth.uid() = reporter_id);
