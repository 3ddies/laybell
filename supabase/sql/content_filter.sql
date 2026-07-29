-- Content filter — the curated term blocklist behind lib/contentFilter.ts.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
--
-- WHY: Apple Guideline 1.2 and Play's UGC policy expect a UGC app to have "a
-- method for filtering objectionable material from being posted." Laybell had
-- reporting, blocking and a moderation console — all REACTIVE. This is the
-- proactive half.
--
-- Mirrors blocked_link_domains from link_safety.sql: the client merges this over a
-- small built-in seed, so moderation policy can change without an app release.
-- Until this runs, the seed alone applies and nothing breaks.
--
-- Terms are matched on WORD BOUNDARIES against normalized text (case-folded,
-- de-accented, leetspeak-collapsed, repeat-collapsed). So a row for "badword"
-- catches "B4DW0RD" and "b-a-d-w-o-r-d" but NOT "badwordsmith" — add stems
-- deliberately rather than relying on substring behaviour.

create table if not exists public.blocked_terms (
  term       text primary key,
  -- 'block'  → the write is refused outright.
  -- 'review' → the write goes through but is flagged for the moderation queue.
  severity   text not null default 'block' check (severity in ('block', 'review')),
  -- Free-text note for whoever reads this table in six months.
  reason     text,
  created_at timestamptz not null default now()
);

alter table public.blocked_terms enable row level security;

-- Signed-in clients READ the list so they can cache and enforce it. Note this
-- makes the list readable by anyone with an account — which is inherent to
-- client-side filtering and is why the filter is a speed bump, not a boundary.
-- Nothing sensitive belongs in `reason`.
drop policy if exists "Anyone signed in can read blocked terms" on public.blocked_terms;
create policy "Anyone signed in can read blocked terms"
  on public.blocked_terms for select
  to authenticated
  using (true);

-- No insert/update/delete policy: the list is maintained from the Dashboard or by
-- the service role only. A client must never be able to edit the filter that
-- constrains it.

-- ── Seeding ──────────────────────────────────────────────────────────────────
-- Left EMPTY on purpose. The built-in seed in lib/contentFilter.ts covers slurs
-- and sexual-solicitation patterns; this table is where the owner's own policy
-- goes, and what belongs in it is a moderation decision, not a migration.
--
-- Add terms like:
--   insert into public.blocked_terms (term, severity, reason) values
--     ('examplebadword', 'block',  'slur — reported repeatedly'),
--     ('borderlineword', 'review', 'often abusive in context, needs a human')
--   on conflict (term) do update
--     set severity = excluded.severity, reason = excluded.reason;
--
-- Review what is actually getting flagged before expanding this. An over-broad
-- filter trains users to route around it and buries the moderation queue in
-- false positives, which is worse than a narrow one.
