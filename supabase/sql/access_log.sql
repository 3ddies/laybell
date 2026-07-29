-- Access log — server-captured IP addresses for evidence.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
--
-- WHY THIS EXISTS
-- Laybell logged no IP addresses anywhere. That was discovered while completing
-- the NCMEC ESP registration, and it costs twice over:
--
--   1. After the media itself, the originating IP is the field investigators most
--      want. Without it a CyberTipline report is materially less actionable.
--   2. It is the field that WINS card chargebacks. Stripe's dispute evidence has a
--      dedicated `access_activity_log` slot asking for "server or activity logs
--      showing proof that the customer accessed or downloaded the purchased
--      digital product after they made the payment... including IP addresses,
--      corresponding timestamps". On instantly-delivered beat files that is the
--      difference between winning and conceding. See LAUNCH_CHECKLIST §6.5.
--
-- WHY IT IS SERVER-SIDE ONLY
-- A client cannot be trusted to report its own address — self-reported evidence is
-- worth nothing in a dispute and worse than nothing in an investigation. Rows here
-- are written ONLY by the log-access Edge Function, which reads the address from
-- the request itself. No client can insert.
--
-- PRIVACY
-- An IP address is personal data. Collection is disclosed in the Privacy Policy,
-- collection is limited to a small set of security-and-evidence events (not
-- general analytics), and rows are pruned on a schedule — see the bottom.

create table if not exists public.access_log (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users(id) on delete set null,
  -- What happened: 'upload', 'post', 'report', 'shop_download', 'live_start'.
  event        text not null,
  -- What it was about, so the row can be joined to the thing it evidences.
  subject_type text,
  subject_id   text,
  ip           inet,
  -- WHICH HEADER the address came from, because they are not equally trustworthy.
  -- 'cf-connecting-ip' is written by Cloudflare and cannot be forged by the
  -- client. 'x-forwarded-for' CAN be, if a proxy fails to overwrite it. Recording
  -- the source makes the evidence self-describing instead of falsely uniform.
  ip_source    text,
  user_agent   text,
  created_at   timestamptz not null default now()
);

create index if not exists access_log_subject_idx on public.access_log (subject_type, subject_id);
create index if not exists access_log_user_idx    on public.access_log (user_id, created_at desc);
create index if not exists access_log_created_idx on public.access_log (created_at);

alter table public.access_log enable row level security;

-- Users may READ their own rows — this is deliberate. State privacy laws give
-- people a right of access to their own data, and a log they cannot see is harder
-- to defend than one they can. They cannot write, edit, or delete it.
drop policy if exists "Users read their own access log" on public.access_log;
create policy "Users read their own access log"
  on public.access_log for select using (user_id = auth.uid());

-- No insert/update/delete policy for anyone. Writes come from the Edge Function
-- via the service role, which bypasses RLS.

-- Append-only, like the ledger. Evidence you can quietly edit is not evidence.
create or replace function public.access_log_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'access_log is append-only (attempted %)', tg_op;
end $$;

drop trigger if exists access_log_no_update on public.access_log;
create trigger access_log_no_update
  before update on public.access_log
  for each row execute function public.access_log_immutable();
-- NOTE: DELETE is intentionally NOT blocked, unlike the ledger — retention
-- pruning below has to be able to remove old rows. Keeping IP addresses forever
-- would itself be a privacy problem.


-- ─── Retention ──────────────────────────────────────────────────────────────
-- 13 months: comfortably past the ~120-day card-dispute window and past the
-- 1-year CSAM preservation duty (18 U.S.C. §2258A(h)), without keeping personal
-- data indefinitely. Run monthly from the dashboard or a scheduled function.
--
--   delete from public.access_log where created_at < now() - interval '13 months';
--
-- ⚠️ Before pruning, preserve anything tied to an open matter. Rows referenced by
-- a report under legal_hold must be exported first — the retention clock for
-- those is set by the investigation, not by this schedule.


-- ─── Chargeback export ──────────────────────────────────────────────────────
-- Everything Stripe asks for in `access_activity_log`, for one disputed order:
--
--   select l.created_at, l.ip, l.ip_source, l.user_agent,
--          d.file_path, o.price_cents, o.created_at as ordered_at
--     from public.access_log l
--     join public.shop_orders o on o.id::text = l.subject_id
--     left join public.shop_downloads d on d.order_id = o.id
--    where l.event = 'shop_download' and l.subject_id = '<order uuid>'
--    order by l.created_at;
