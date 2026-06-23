-- Link safety — blocklist + reports + decision audit (Supabase tables + RLS).
-- Run in the Supabase Dashboard → SQL Editor (the anon key cannot create tables).
--
-- Backs lib/linkSafety.ts + contexts/LinkGuardContext.tsx. EVERYTHING degrades
-- gracefully: until this is applied, the app falls back to its built-in offline
-- heuristics + seed blocklist, link reports/audit inserts silently no-op, and
-- nothing breaks.

-- ── 1) Curated domain blocklist ──────────────────────────────────────────────
-- The authoritative denylist the app fetches once at startup (loadBlocklist) and
-- merges over its built-in seed. Populate from a feed (URLhaus, PhishTank, your
-- own moderation) via the service role / Dashboard. Host-or-suffix match in app:
-- a row for "evil.com" also blocks "login.evil.com".
create table if not exists public.blocked_link_domains (
  domain     text primary key,
  reason     text,
  severity   text not null default 'block',   -- 'block' | 'warn'
  added_by   uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.blocked_link_domains enable row level security;

-- Everyone signed in can READ the blocklist (so the client can cache it).
create policy "Anyone can read the blocklist"
on public.blocked_link_domains for select
to authenticated
using (true);

-- No client write policy on purpose: only the service role / Dashboard (which
-- bypass RLS) may add or remove blocked domains. This keeps the denylist trusted.

-- ── 2) User-reported links ───────────────────────────────────────────────────
-- Filed from the "Report this link" action in the leaving-Laybell interstitial.
create table if not exists public.link_reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid references auth.users(id) on delete set null,
  url         text not null,
  host        text,
  context     text,                            -- 'bio' | 'message' | 'ad' | 'other'
  verdict     text,                            -- the client's verdict at report time
  reasons     text[],
  created_at  timestamptz not null default now()
);

create index if not exists link_reports_host_idx on public.link_reports(host);
create index if not exists link_reports_created_idx on public.link_reports(created_at desc);

alter table public.link_reports enable row level security;

create policy "Users can file link reports"
on public.link_reports for insert
to authenticated
with check (auth.uid() = reporter_id);

create policy "Users can view own link reports"
on public.link_reports for select
to authenticated
using (auth.uid() = reporter_id);

-- ── 3) Decision audit log ────────────────────────────────────────────────────
-- A best-effort record of block/open/cancel decisions. This is the evidence of
-- "reasonable handling": it shows links were screened and dangerous ones stopped.
create table if not exists public.link_audit (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) on delete set null,
  url        text not null,
  host       text,
  verdict    text,                             -- 'allow' | 'warn' | 'block'
  reasons    text[],
  action     text,                             -- 'opened' | 'blocked' | 'cancelled'
  context    text,
  created_at timestamptz not null default now()
);

create index if not exists link_audit_host_idx on public.link_audit(host);
create index if not exists link_audit_created_idx on public.link_audit(created_at desc);

alter table public.link_audit enable row level security;

create policy "Users can write their own link audit"
on public.link_audit for insert
to authenticated
with check (auth.uid() = user_id);

create policy "Users can view their own link audit"
on public.link_audit for select
to authenticated
using (auth.uid() = user_id);

-- ── Seeding the blocklist (optional) ─────────────────────────────────────────
-- Add known-bad domains here or sync them from a threat feed, e.g.:
--   insert into public.blocked_link_domains (domain, reason) values
--     ('example-phishing.com', 'phishing'),
--     ('malware.test', 'malware')
--   on conflict (domain) do nothing;
