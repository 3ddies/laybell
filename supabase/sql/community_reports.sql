-- Community reports — the report path behind the 3-dot menu on a community page.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
-- Requires communities.sql (public.communities).
--
-- Mirrors conversation_reports.sql exactly: a reporter files, only the reporter
-- can read their own filings back, and staff read it through the service role
-- in the admin console. Deliberately no UPDATE/DELETE policy — a report is a
-- record of what someone said at a moment, not an editable document.
--
-- Until this runs, lib/postActions.submitCommunityReport's insert simply fails
-- and is swallowed, so the button still opens and closes cleanly; it just
-- records nothing. Run it before relying on the queue.

create table if not exists public.community_reports (
  id           uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  reporter_id  uuid references auth.users(id) on delete set null,
  reason       text not null default 'other',
  created_at   timestamptz not null default now()
);

create index if not exists community_reports_community_idx
  on public.community_reports(community_id);

alter table public.community_reports enable row level security;

drop policy if exists "Users can file community reports" on public.community_reports;
create policy "Users can file community reports"
  on public.community_reports for insert
  with check (auth.uid() = reporter_id);

drop policy if exists "Users can view own community reports" on public.community_reports;
create policy "Users can view own community reports"
  on public.community_reports for select
  using (auth.uid() = reporter_id);
