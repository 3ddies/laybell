-- ═══════════════════════════════════════════════════════════════════════════
-- LAYBELL — LAUNCH SQL, 2026-07-29
--
-- Paste this whole file into the Supabase Dashboard -> SQL Editor and run once.
-- Every statement is idempotent (create or replace / if not exists), so a
-- re-run is safe and a partial failure can be fixed and re-run from the top.
--
-- THE ORDER MATTERS. ledger_spend.sql calls payout_hold_days(), which payouts
-- defines, and shop_credits calls it too. Running these files individually in a
-- different order fails with "function does not exist".
--
--   1. geo_block     Mississippi HB 1126 region block
--   2. mlc_meter     mechanical-licensing decision trigger
--   3. payouts       creator payouts + the 14-day hold
--   4. shop_credits  shop sells through credits
--   5. ledger_spend  RE-RUN: new tip fee rate, the hold, donation_guard v4
--
-- AFTER RUNNING, verify:
--   select * from public.ledger_verify();     -- rows ONLY on drift
--   select public.tip_fee_rate(auth.uid());   -- 0.35 (0.20 if you are Premium)
--   select public.shop_fee_rate();            -- 0.25
--   select public.payout_min_cents();         -- 2500
--   select region_code, reason from public.blocked_regions;  -- MS
-- ═══════════════════════════════════════════════════════════════════════════



-- ═══════════════════════════════════════════════════════════════════════════
-- FILE: supabase/sql/geo_block.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- Region blocking — Mississippi HB 1126.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
--
-- WHY THIS EXISTS
-- Mississippi's Walker Montgomery Protecting Children Online Act (HB 1126)
-- requires commercially reasonable age verification for every user, verifiable
-- parental consent for minors, and a design duty toward minors. Unlike almost
-- every comparable state law, IT HAS NO SIZE THRESHOLD — it binds a service with
-- ten users exactly as it binds one with ten million. Enforcement is by the
-- state Attorney General, per violation.
--
-- Laybell's answer for v1 is not to serve Mississippi. Third-party age assurance
-- costs roughly $0.30–$2.00 per verification, which is unaffordable pre-revenue,
-- and an identity check standing between a stranger and their first look at the
-- app is the single most reliable way to kill a young social product. Mississippi
-- is ~1% of the US population. That is the cheaper mistake.
--
-- THIS IS EXPECTED TO BE TEMPORARY. Utah, Texas, Louisiana, Arkansas, Florida,
-- Tennessee and others have passed comparable laws in varying states of
-- injunction, and that status changes month to month. When Laybell can afford
-- real age assurance, this list should shrink to nothing. Everything here is
-- built to be lifted: no data is destroyed, and unblocking is one UPDATE.
--
-- WHY THE ENFORCEMENT IS HERE AND NOT IN THE APP
-- A client-side check would be decorative. `profiles` rows are created by the
-- handle_new_user() trigger on auth.users, which is deliberately failure-tolerant
-- ("NEVER block account creation over the profile row"), AND by
-- ensureProfileForSession() on first login, AND social sign-in skips the signup
-- screen entirely — three paths that never execute app code. So the app layer is
-- UX, and this file is the control. Same division as minor_safety.sql.

-- ─── Column ─────────────────────────────────────────────────────────────────
-- `region_code` is the USPS code the user selected during onboarding.
-- `region_blocked_at` is set when that selection lands in a blocked region.
--
-- Two columns rather than one derived check, because the block must SURVIVE the
-- list changing. If Mississippi is later removed from the blocked list, existing
-- blocked accounts should be reviewed and lifted deliberately, not silently
-- resurrected by an unrelated deploy.
alter table public.profiles add column if not exists region_code       text;
alter table public.profiles add column if not exists region_blocked_at timestamptz;

create index if not exists profiles_region_blocked_idx
  on public.profiles (region_blocked_at)
  where region_blocked_at is not null;


-- ─── The list ───────────────────────────────────────────────────────────────
-- A table rather than a hardcoded constant so a region can be unblocked without
-- a deploy — this list will change faster than the app ships, and being stuck
-- blocking a state whose law got enjoined is a self-inflicted wound.
--
-- Keep in sync with BLOCKED_REGIONS in lib/geoBlock.ts, which is the app-side
-- copy used for the onboarding message.
create table if not exists public.blocked_regions (
  region_code text primary key,
  country     text not null default 'US',
  reason      text not null,
  added_at    timestamptz not null default now()
);

insert into public.blocked_regions (region_code, reason) values
  ('MS', 'Mississippi HB 1126 — age verification and parental consent with no size threshold. Revisit when age assurance is affordable.')
on conflict (region_code) do nothing;

alter table public.blocked_regions enable row level security;

-- Readable by anyone signed in: the app needs it to explain the block, and the
-- list of US states a service declines to operate in is not a secret. Writes are
-- service-role only (no policy grants insert/update/delete).
drop policy if exists "Blocked regions are readable" on public.blocked_regions;
create policy "Blocked regions are readable"
  on public.blocked_regions for select
  to authenticated
  using (true);


-- ─── Recording a region ─────────────────────────────────────────────────────
-- Called from onboarding. SECURITY DEFINER so the block stamp is applied by the
-- server against the server's own list — a client that simply omitted the
-- `region_blocked_at` write must not be able to opt out of being blocked.
--
-- Returns true when the caller is blocked, so the app can react immediately
-- rather than waiting for the next session check.
create or replace function public.set_region(p_region_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code    text;
  v_blocked boolean;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  v_code := upper(nullif(btrim(p_region_code), ''));
  if v_code is null or v_code !~ '^[A-Z]{2}$' then
    raise exception 'region_code must be a two-letter code';
  end if;

  select exists (
    select 1 from public.blocked_regions br where br.region_code = v_code
  ) into v_blocked;

  update public.profiles p
     set region_code       = v_code,
         -- Never clear an existing stamp here. Lifting a block is a deliberate
         -- act (see "Unblocking" below), not something a user achieves by
         -- re-running onboarding and picking a different state.
         region_blocked_at = case
                               when p.region_blocked_at is not null then p.region_blocked_at
                               when v_blocked then now()
                               else null
                             end
   where p.id = auth.uid();

  return v_blocked or exists (
    select 1 from public.profiles p2
     where p2.id = auth.uid() and p2.region_blocked_at is not null
  );
end $$;

grant execute on function public.set_region(text) to authenticated;


-- ─── The gate ───────────────────────────────────────────────────────────────
-- SECURITY DEFINER so it can read profiles regardless of the caller's own RLS,
-- STABLE so Postgres caches it within a statement rather than re-running it per
-- row.
--
-- NOTE THE ASYMMETRY, which matches lib/minors.ts: this returns true only for a
-- user AFFIRMATIVELY KNOWN to be in a blocked region. A user with no region
-- recorded is not blocked. Unknown is not a restriction — otherwise every
-- account would be frozen between signup and the onboarding question, including
-- every existing account created before this migration.
create or replace function public.in_blocked_region()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.region_blocked_at is not null
  );
$$;

grant execute on function public.in_blocked_region() to authenticated;


-- ─── Enforcement ────────────────────────────────────────────────────────────
-- RESTRICTIVE policies AND with everything already present, rather than adding
-- an alternative way in. A blocked account keeps its data and can still read;
-- it simply cannot participate. Read access is left alone deliberately — the
-- concern is operating a social service for Mississippi minors, not punishing
-- someone who already has an account.
--
-- Each policy is dropped first so re-running this file doesn't error.

drop policy if exists "Blocked regions cannot post" on public.posts;
create policy "Blocked regions cannot post"
  on public.posts as restrictive for insert
  to authenticated
  with check (not public.in_blocked_region());

drop policy if exists "Blocked regions cannot comment" on public.comments;
create policy "Blocked regions cannot comment"
  on public.comments as restrictive for insert
  to authenticated
  with check (not public.in_blocked_region());

drop policy if exists "Blocked regions cannot message" on public.messages;
create policy "Blocked regions cannot message"
  on public.messages as restrictive for insert
  to authenticated
  with check (not public.in_blocked_region());


-- ─── Operating it ───────────────────────────────────────────────────────────
-- How many accounts are affected:
--
--   select region_code, count(*)
--     from public.profiles
--    where region_blocked_at is not null
--    group by region_code;
--
-- UNBLOCKING a region — when a law is enjoined, or age assurance ships. Both
-- steps are required: removing the list entry stops NEW blocks, and clearing the
-- stamps releases the accounts already caught.
--
--   delete from public.blocked_regions where region_code = 'MS';
--   update public.profiles
--      set region_blocked_at = null
--    where region_code = 'MS';
--
-- Then remove 'MS' from BLOCKED_REGIONS in lib/geoBlock.ts so the app stops
-- offering the explanation.
--
-- ADDING a region:
--
--   insert into public.blocked_regions (region_code, reason)
--   values ('XX', 'why');
--
-- Existing accounts already in that state are NOT retroactively blocked by the
-- insert — set_region only stamps on write. To apply it retroactively:
--
--   update public.profiles
--      set region_blocked_at = now()
--    where region_code = 'XX' and region_blocked_at is null;


-- ═══════════════════════════════════════════════════════════════════════════
-- FILE: supabase/sql/mlc_meter.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- Mechanical-licensing decision meter.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
--
-- WHY THIS EXISTS
-- Laybell does not hold a blanket mechanical licence from the Mechanical
-- Licensing Collective. It operates on a direct-licence posture: every recording
-- is uploaded by a user who warrants under Terms §7 that they control the
-- composition, the master, the samples and the performances. That is the same
-- posture SoundCloud and Bandcamp launched on, and it is defensible for a
-- user-generated-content service that licenses no commercial catalogue.
--
-- It stops being defensible at scale, and the cost of being wrong is a cliff
-- rather than a slope. The MLC's administrative assessment is tiered by the
-- number of unique sound recordings a service makes available per month, and
-- the jump between tiers is roughly 24x:
--
--     under ~10,000/month     ~$2,500/year
--     above ~25,000/month    ~$60,000/year
--
-- So this is NOT a compliance meter like stream_hours.sql — nothing
-- auto-terminates, no notice is owed to anyone. It is a DECISION TRIGGER. It
-- answers one question: "is Laybell still small enough for the direct-licence
-- posture to be the obviously correct call?" Crossing 10,000 is the signal to
-- get an actual lawyer on the question while the answer is still cheap.
--
-- ⚠️ VERIFY THE THRESHOLDS before acting on them. The assessment is set by
-- Copyright Royalty Board determination and is periodically revised. The two
-- numbers above were researched on 2026-07-28 and are wired in as DEFAULTS you
-- pass over, not as constants — see the p_small_tier / p_large_tier arguments.
--
-- WHAT COUNTS AS A "SOUND RECORDING" HERE
-- Musical works only. Podcasts and audiobooks are spoken word, not musical
-- compositions, and carry no mechanical-licensing exposure — so `type = 'audio'`
-- and nothing else. Counting them would inflate the figure and could push a
-- premature and expensive decision.


-- ─── Reporting ──────────────────────────────────────────────────────────────
-- Two readings of the same month, for the same reason stream_hours.sql gives
-- two: one number alone invites you to believe it.
--
-- `recordings_streamed`  — distinct musical recordings that were actually played.
--                          The NARROW reading. Under-counts slightly: public.streams
--                          deduplicates (a listener replaying a track inside 24h
--                          adds no row), so a recording played only by people who
--                          had already heard it can be missed.
-- `recordings_available` — every public musical recording in the catalogue at
--                          month end. The CONSERVATIVE reading, and the closer
--                          match to "makes available", which is the language the
--                          assessment actually uses.
--
--   select * from public.mlc_usage('2026-07-01');
create or replace function public.mlc_usage(
  p_month        date,
  p_small_tier   bigint default 10000,
  p_large_tier   bigint default 25000
)
returns table (
  month                 date,
  recordings_streamed   bigint,
  recordings_available  bigint,
  pct_of_small_tier     numeric,
  status                text
)
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select date_trunc('month', p_month)::date                      as m_start,
           (date_trunc('month', p_month) + interval '1 month')::date as m_end
  ),
  streamed as (
    select count(distinct s.post_id) as n
      from public.streams s
      join public.posts p on p.id = s.post_id
     cross join bounds b
     where s.created_at >= b.m_start
       and s.created_at <  b.m_end
       and p.type = 'audio'
  ),
  available as (
    select count(*) as n
      from public.posts p
     cross join bounds b
     where p.type = 'audio'
       and p.is_public
       and p.archived_at is null
       and p.created_at < b.m_end
  )
  select
    b.m_start,
    streamed.n,
    available.n,
    round((greatest(streamed.n, available.n)::numeric / nullif(p_small_tier, 0)) * 100, 1),
    case
      when greatest(streamed.n, available.n) >= p_large_tier
        then 'ACT NOW — past the large-tier line. The assessment jump is roughly 24x. Get licensing counsel before the next reporting period.'
      when greatest(streamed.n, available.n) >= p_small_tier
        then 'REVIEW — past the small-tier line. Time to have the blanket-licence conversation with a lawyer while it is still cheap.'
      when greatest(streamed.n, available.n) >= p_small_tier * 0.5
        then 'WATCH — halfway. Check monthly from here.'
      else 'OK — direct-licence posture remains the obviously correct call.'
    end
  from bounds b, streamed, available;
$$;

-- Owner/dashboard only. Postgres grants EXECUTE to PUBLIC by default, and
-- catalogue size is commercially sensitive.
revoke all on function public.mlc_usage(date, bigint, bigint) from public;
revoke all on function public.mlc_usage(date, bigint, bigint) from authenticated;


-- ─── Trend ──────────────────────────────────────────────────────────────────
-- A single month tells you where you are; twelve tell you when you will arrive.
-- Growth is what matters here — the decision needs lead time, because finding
-- and briefing a lawyer is not a same-week activity.
--
--   select * from public.mlc_usage_trend(12);
create or replace function public.mlc_usage_trend(p_months int default 12)
returns table (
  month                 date,
  recordings_streamed   bigint,
  recordings_available  bigint,
  pct_of_small_tier     numeric,
  status                text
)
language sql
stable
security definer
set search_path = public
as $$
  select u.*
    from generate_series(
           date_trunc('month', current_date) - ((p_months - 1) || ' months')::interval,
           date_trunc('month', current_date),
           interval '1 month'
         ) as g(m)
   cross join lateral public.mlc_usage(g.m::date) as u
   order by u.month desc;
$$;

revoke all on function public.mlc_usage_trend(int) from public;
revoke all on function public.mlc_usage_trend(int) from authenticated;


-- ─── Use it ─────────────────────────────────────────────────────────────────
-- CHECK THIS QUARTERLY. It moves slower than the BMI meter and needs less
-- attention, but it needs more lead time when it does move.
--
--   select * from public.mlc_usage_trend(12);
--
-- If the trend line is heading for 10,000/month within two quarters, that is the
-- moment to act — not the moment you cross it.
--
-- FREE ROUTE TO ADVICE: Maryland Volunteer Lawyers for the Arts does pro bono
-- work for Maryland creatives. Mechanical licensing for a UGC platform is the
-- single most genuinely ambiguous legal question Laybell has, and it is the one
-- most worth spending a free consultation on.
--
-- See docs/LAUNCH_CHECKLIST.md and docs/PRO_LICENSING_PACK.md for the wider
-- licensing picture (BMI is metered separately by stream_hours.sql, and that one
-- IS a compliance meter — the licence auto-terminates).


-- ═══════════════════════════════════════════════════════════════════════════
-- FILE: supabase/sql/payouts.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- Creator payouts.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
-- REQUIRES: ledger.sql, ledger_spend.sql, stripe_connect.sql.
--
-- ─── THE LEGAL FRAME, WHICH IS THE WHOLE DESIGN ─────────────────────────────
--
-- The obvious way to build this is also the illegal one: take the fan's money,
-- hold it, hand it to the creator. That is transmitting a third party's funds,
-- and doing it without a licence is a federal crime (18 U.S.C. §1960) plus
-- roughly fifty state money-transmitter licences that a pre-revenue company
-- cannot obtain.
--
-- What Laybell does instead — and what the credits ledger already implements:
--
--   1. The fan buys CREDITS FROM LAYBELL. Their contract is with Laybell, not
--      with the creator. Apple or Google is the merchant of record.
--   2. Credits are non-cashable and non-transferable. Spend-only.
--   3. Spending credits creates a CONTRACTUAL OBLIGATION from Laybell to the
--      creator — a revenue share Laybell owes on its own account.
--   4. Paying that out is LAYBELL PAYING ITS OWN DEBT, which is not money
--      transmission.
--
-- This is the Twitch Bits / YouTube Super Thanks / TikTok Coins structure.
-- Laybell is the principal, never an intermediary.
--
-- THE ONE RULE THAT MUST NEVER BREAK: no path may ever convert credits back to
-- money. The moment credits are redeemable they become stored value, and the
-- whole analysis above collapses. There is deliberately no credits→bank
-- function here, and there must never be one, however reasonable the feature
-- request sounds.

-- ─── Configuration ──────────────────────────────────────────────────────────
-- $25.00. Stripe charges per payout, so paying out $3 costs a meaningful
-- fraction of $3. A minimum also collapses the number of transfers to reconcile.
create or replace function public.payout_min_cents()
returns int language sql immutable as $$ select 2500 $$;

-- 14 days. A creator's earnings are withdrawable only after this clears.
--
-- The exposure is specific: a fan buys credits with IAP, tips a creator, the
-- creator withdraws, and THEN the fan refunds the purchase. `ledger_post`
-- refuses to settle a user account negative, so the refund fails and Laybell
-- eats the loss with no way to claw it back. A hold does not eliminate that —
-- store refund windows run far longer — but the overwhelming majority of
-- purchase fraud surfaces within days, and this is the standard shape (Twitch
-- holds ~15 days, YouTube pays monthly in arrears).
create or replace function public.payout_hold_days()
returns int language sql immutable as $$ select 14 $$;


-- ─── The payout record ──────────────────────────────────────────────────────
-- Separate from the ledger because a payout has a LIFECYCLE the ledger does not
-- model. Ledger entries are immutable facts; a payout is pending, then paid or
-- failed, and Stripe tells us which asynchronously, sometimes days later.
create table if not exists public.payouts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  amount_cents       bigint not null check (amount_cents > 0),
  currency           text not null default 'USD',
  status             text not null default 'pending'
                       check (status in ('pending', 'paid', 'failed', 'reversed')),
  stripe_account_id  text,
  stripe_transfer_id text,
  failure_reason     text,
  ledger_tx_id       uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists payouts_user_idx on public.payouts (user_id, created_at desc);

-- At most ONE pending payout per user. This is the double-submit guard: the tip
-- flow's idempotency key defends against retries of the same event, not against
-- a user tapping a button twice, and two concurrent payouts would each see the
-- same available balance.
create unique index if not exists payouts_one_pending_idx
  on public.payouts (user_id) where status = 'pending';

-- Stripe transfer ids are unique; this makes webhook replay harmless.
create unique index if not exists payouts_transfer_uniq
  on public.payouts (stripe_transfer_id) where stripe_transfer_id is not null;

alter table public.payouts enable row level security;

drop policy if exists "Users read own payouts" on public.payouts;
create policy "Users read own payouts"
  on public.payouts for select
  to authenticated
  using (user_id = auth.uid());
-- No insert/update/delete policy: everything is written by the SECURITY DEFINER
-- function below or by the service role from the webhook.


-- ─── Available balance ──────────────────────────────────────────────────────
-- Earnings that have cleared the hold AND are not already committed to a pending
-- payout. The second half matters: the ledger is debited when a payout is
-- REQUESTED, but a pending row that later fails gets reversed, and between those
-- two moments the money must not appear spendable twice.
create or replace function public.payout_available_cents()
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select sum(e.amount_cents)
      from public.ledger_entries e
      join public.ledger_accounts a on a.id = e.account_id
     where a.user_id = auth.uid()
       and a.kind = 'earnings'
       and e.available_at <= now()
  ), 0);
$$;

grant execute on function public.payout_available_cents() to authenticated;


-- ─── Requesting a payout ────────────────────────────────────────────────────
-- Debits the ledger IMMEDIATELY, before Stripe is contacted. That ordering is
-- deliberate: if the transfer call fails we reverse a debit that already
-- happened, which is recoverable. The other order — call Stripe, then debit —
-- means a crash between the two pays the creator twice.
--
-- Returns the payout row id; the Edge Function then performs the transfer.
create or replace function public.request_payout(p_amount_cents bigint)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user      uuid := auth.uid();
  v_available bigint;
  v_account   text;
  v_payout_id uuid;
  v_tx_id     uuid;
begin
  if v_user is null then raise exception 'not_signed_in'; end if;

  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'invalid_amount';
  end if;

  if p_amount_cents < public.payout_min_cents() then
    raise exception 'below_minimum';
  end if;

  select p.stripe_account_id into v_account
    from public.profiles p where p.id = v_user;
  if v_account is null then raise exception 'no_connected_account'; end if;

  if exists (select 1 from public.payouts po
              where po.user_id = v_user and po.status = 'pending') then
    raise exception 'payout_already_pending';
  end if;

  v_available := public.payout_available_cents();
  if p_amount_cents > v_available then raise exception 'insufficient_available'; end if;

  insert into public.payouts (user_id, amount_cents, stripe_account_id)
  values (v_user, p_amount_cents, v_account)
  returning id into v_payout_id;

  -- Creator's earnings down, platform up: Laybell is settling a debt it owed.
  -- The platform account may go negative by design, which is exactly what this
  -- represents — money leaving Laybell.
  v_tx_id := public.ledger_post(
    'payout',
    jsonb_build_array(
      jsonb_build_object('user', v_user, 'kind', 'earnings', 'amount_cents', -p_amount_cents),
      jsonb_build_object('user', null,   'kind', 'platform', 'amount_cents',  p_amount_cents)
    ),
    'stripe',
    'payout:' || v_payout_id::text,
    'Creator payout',
    jsonb_build_object('payout_id', v_payout_id)
  );

  update public.payouts po set ledger_tx_id = v_tx_id where po.id = v_payout_id;
  return v_payout_id;
end $$;

grant execute on function public.request_payout(bigint) to authenticated;


-- ─── Settling a payout ──────────────────────────────────────────────────────
-- Called by the Stripe webhook (service role only). Idempotent: settling an
-- already-settled payout is a no-op, because Stripe retries webhooks and will
-- happily deliver the same event more than once.
create or replace function public.settle_payout(
  p_payout_id  uuid,
  p_status     text,
  p_transfer_id text default null,
  p_reason     text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payout public.payouts;
begin
  if p_status not in ('paid', 'failed') then raise exception 'bad_status'; end if;

  select * into v_payout from public.payouts po where po.id = p_payout_id for update;
  if not found then raise exception 'payout_not_found'; end if;
  if v_payout.status <> 'pending' then return; end if;   -- already settled

  if p_status = 'paid' then
    update public.payouts po
       set status = 'paid', stripe_transfer_id = coalesce(p_transfer_id, po.stripe_transfer_id),
           updated_at = now()
     where po.id = p_payout_id;
    return;
  end if;

  -- Failed: give the money back. The reversal is a separate ledger transaction
  -- rather than an edit, because ledger entries are append-only — an
  -- `ledger_entries_no_update` trigger rejects UPDATE and DELETE even for the
  -- service role.
  perform public.ledger_post(
    'adjustment',
    jsonb_build_array(
      jsonb_build_object('user', v_payout.user_id, 'kind', 'earnings', 'amount_cents',  v_payout.amount_cents),
      jsonb_build_object('user', null,             'kind', 'platform', 'amount_cents', -v_payout.amount_cents)
    ),
    'stripe',
    'payout-reversal:' || p_payout_id::text,
    'Payout failed — returned to balance',
    jsonb_build_object('payout_id', p_payout_id, 'reason', p_reason)
  );

  update public.payouts po
     set status = 'failed', failure_reason = p_reason, updated_at = now()
   where po.id = p_payout_id;
end $$;

-- Service role only — this moves money.
revoke all on function public.settle_payout(uuid, text, text, text) from public;
revoke all on function public.settle_payout(uuid, text, text, text) from authenticated;


-- ─── The hold lives in ledger_spend.sql ─────────────────────────────────────
-- tip_post_internal now stamps the host's earnings leg with
-- `available_at = now() + payout_hold_days()`. It is defined there rather than
-- redefined here so there is exactly one definition of that function — a copy in
-- this file would silently revert the hold the next time ledger_spend.sql was
-- re-run.
--
-- ⚠️ RE-RUN ledger_spend.sql AFTER THIS FILE. It now calls payout_hold_days(),
-- which does not exist until the top of this file has been applied.
--
-- Existing entries are NOT retroactively held. They were earned under the old
-- terms, and reaching back to freeze money a creator can already see would be
-- both unfair and a support nightmare.


-- ─── Operating it ───────────────────────────────────────────────────────────
--   select id, user_id, amount_cents, status, failure_reason, created_at
--     from public.payouts order by created_at desc limit 50;
--
-- Stuck pending (Stripe never called back — check the webhook is reachable):
--   select * from public.payouts
--    where status = 'pending' and created_at < now() - interval '1 hour';
--
-- Books still balance after all this:
--   select * from public.ledger_verify();   -- returns rows ONLY on drift
--
-- Total paid out this month:
--   select sum(amount_cents)/100.0 as dollars from public.payouts
--    where status = 'paid' and created_at >= date_trunc('month', current_date);


-- ═══════════════════════════════════════════════════════════════════════════
-- FILE: supabase/sql/shop_credits.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- Shop purchases through credits.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
-- REQUIRES: ledger.sql, ledger_spend.sql, payouts.sql, shop.sql, shop_multi.sql.
--
-- WHY THIS CHANGED
-- The shop used to be a venue: `requestToBuy` inserted an order and sent the
-- seller a DM, and the two of them settled up privately. Laybell touched no
-- money and earned none — the "Earned" figure on the shop screen was 85% of
-- cash that had never passed through Laybell.
--
-- That is not survivable at review time. The buyer pays outside the app, but the
-- FILE IS DELIVERED INSIDE IT via a signed storage URL, and selling digital
-- goods with in-app delivery is what Guideline 3.1.1 exists to stop. Apple
-- forced Patreon onto IAP for exactly this. Physical-goods marketplaces are fine
-- because the goods are physical; a beat is not.
--
-- So purchases now spend credits, which are bought through Apple and Google.
-- Two things fall out of that, both good: Apple becomes merchant of record and
-- handles the sales tax that would otherwise make Laybell a marketplace
-- facilitator, and the money is finally real.
--
-- ─── THE FEE HAD TO CHANGE, AND HERE IS THE ARITHMETIC ──────────────────────
-- The old 15% fee predates credits, and against IAP funding it earns nothing:
--
--   $10 beat = 1000 credits
--   Buyer paid Apple $10 → Apple keeps 15% → LAYBELL RECEIVED $8.50
--   Seller is owed 85% of 1000 credits                    = $8.50
--   Laybell keeps                                         = $0.00
--
-- The platform fee and the store commission cancel out exactly. At 25%:
--
--   Laybell received $8.50, owes the seller 75% = $7.50 → nets $1.00 (10% gross)
--
-- 75% to the seller is below BeatStars (~90%) and Bandcamp (~82-85%), and that
-- gap is Apple's commission, not greed. The seller UI states the split plainly
-- rather than letting them discover it at payout — a creator who expected 90%
-- and got 75% churns, and tells people why.
--
-- ⚠️ ENROLL IN THE APP STORE SMALL BUSINESS PROGRAM. It moves Apple's cut from
-- 30% to 15% for under $1M/year. Every number above assumes 15%. At 30% the
-- seller's 75% would cost Laybell money on every sale.
--
-- The rate is a function, not a constant, so it can be repriced without a deploy.

create or replace function public.shop_fee_rate()
returns numeric language sql immutable as $$ select 0.25 $$;


-- ─── Buying ─────────────────────────────────────────────────────────────────
-- Deliberately inserts the order and lets `shop_order_precheck` (shop_multi.sql)
-- run, rather than re-deriving anything. That trigger is already the authority
-- on which deal types a listing offers, what each costs, and whether the free
-- unlock conditions are met — duplicating that logic here would mean two
-- versions of it drifting apart, and the price is the one number that must never
-- be wrong.
--
-- The client passes a listing and a kind. It does NOT pass a price, and the fee
-- is recomputed here: `shop_orders.fee_cents` used to be whatever the client
-- sent, which was harmless when no money moved and is not harmless now.
create or replace function public.shop_buy_with_credits(
  p_listing_id  uuid,
  p_kind        text,
  p_offer_cents int default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_buyer  uuid := auth.uid();
  v_seller uuid;
  v_order  public.shop_orders%rowtype;
  v_fee    bigint;
  v_payout bigint;
  v_tx     uuid;
begin
  if v_buyer is null then raise exception 'not_signed_in'; end if;
  if p_kind not in ('sell', 'lease', 'free', 'offer') then raise exception 'bad_kind'; end if;

  select l.user_id into v_seller from public.shop_listings l where l.id = p_listing_id;
  if v_seller is null then raise exception 'listing_not_found'; end if;
  if v_seller = v_buyer then raise exception 'cannot_buy_own'; end if;

  insert into public.shop_orders (listing_id, buyer_id, seller_id, kind, price_cents, status)
  values (
    p_listing_id, v_buyer, v_seller, p_kind,
    -- Only offers carry a client-named price, and the trigger rejects a
    -- non-positive one. Every other kind is overwritten by the trigger.
    case when p_kind = 'offer' then coalesce(p_offer_cents, 0) else 0 end,
    'requested'
  )
  returning * into v_order;

  -- Free claims: the trigger already verified the follow/like conditions and
  -- delivered. No money exists to move.
  if p_kind = 'free' then
    return jsonb_build_object('ok', true, 'order_id', v_order.id, 'price_cents', 0, 'delivered', true);
  end if;

  v_fee    := round(v_order.price_cents * public.shop_fee_rate());
  v_payout := v_order.price_cents - v_fee;

  if p_kind = 'offer' then
    -- An offer needs the seller's agreement, so the credits are held rather than
    -- paid: buyer → platform now, platform → seller on acceptance, platform →
    -- buyer on decline. Holding at offer time is what stops a seller accepting
    -- an offer the buyer has since spent the credits for.
    v_tx := public.ledger_post(
      'purchase',
      jsonb_build_array(
        jsonb_build_object('user', v_buyer, 'kind', 'credits',  'amount_cents', -v_order.price_cents),
        jsonb_build_object('user', null,    'kind', 'platform', 'amount_cents',  v_order.price_cents)
      ),
      'internal', 'shop-offer:' || v_order.id::text, 'Shop offer held'
    );
    update public.shop_orders o set fee_cents = v_fee where o.id = v_order.id;
    return jsonb_build_object('ok', true, 'order_id', v_order.id,
                              'price_cents', v_order.price_cents, 'delivered', false,
                              'transaction_id', v_tx);
  end if;

  -- sell / lease — paid up front, so deliver immediately. The buyer has already
  -- parted with the money; making them wait for the seller to press a button is
  -- the worst of both models.
  v_tx := public.ledger_post(
    'purchase',
    jsonb_build_array(
      jsonb_build_object('user', v_buyer,  'kind', 'credits',  'amount_cents', -v_order.price_cents),
      jsonb_build_object('user', v_seller, 'kind', 'earnings', 'amount_cents',  v_payout,
                         'available_at', now() + (public.payout_hold_days() || ' days')::interval),
      jsonb_build_object('user', null,     'kind', 'platform', 'amount_cents',  v_fee)
    ),
    'internal', 'shop:' || v_order.id::text, 'Shop purchase'
  );

  update public.shop_orders o
     set status = 'delivered', delivered_at = now(), fee_cents = v_fee
   where o.id = v_order.id;

  return jsonb_build_object('ok', true, 'order_id', v_order.id,
                            'price_cents', v_order.price_cents, 'fee_cents', v_fee,
                            'seller_cents', v_payout, 'delivered', true,
                            'transaction_id', v_tx);
end $$;

grant execute on function public.shop_buy_with_credits(uuid, text, int) to authenticated;


-- ─── Settling a held offer ──────────────────────────────────────────────────
-- A trigger rather than an RPC, because the app already flips order status from
-- several places (accept, decline, cancel). Anything that moves an offer out of
-- 'requested' has to settle the escrow, and a trigger cannot be forgotten by a
-- caller that didn't know it existed.
create or replace function public.shop_settle_offer()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_fee    bigint;
  v_payout bigint;
begin
  if new.kind is distinct from 'offer' then return new; end if;
  if old.status <> 'requested' then return new; end if;      -- already settled
  if new.status = old.status then return new; end if;
  if coalesce(new.price_cents, 0) <= 0 then return new; end if;

  if new.status = 'delivered' then
    v_fee    := round(new.price_cents * public.shop_fee_rate());
    v_payout := new.price_cents - v_fee;
    perform public.ledger_post(
      'purchase',
      jsonb_build_array(
        jsonb_build_object('user', null,           'kind', 'platform', 'amount_cents', -new.price_cents),
        jsonb_build_object('user', new.seller_id,  'kind', 'earnings', 'amount_cents',  v_payout,
                           'available_at', now() + (public.payout_hold_days() || ' days')::interval),
        jsonb_build_object('user', null,           'kind', 'platform', 'amount_cents',  v_fee)
      ),
      'internal', 'shop-offer-accept:' || new.id::text, 'Shop offer accepted'
    );
    new.fee_cents := v_fee;

  elsif new.status in ('declined', 'cancelled') then
    -- Give the credits back. A refund, not an edit: ledger entries are
    -- append-only and an `ledger_entries_no_update` trigger rejects UPDATE and
    -- DELETE even for the service role.
    perform public.ledger_post(
      'refund',
      jsonb_build_array(
        jsonb_build_object('user', null,          'kind', 'platform', 'amount_cents', -new.price_cents),
        jsonb_build_object('user', new.buyer_id,  'kind', 'credits',  'amount_cents',  new.price_cents)
      ),
      'internal', 'shop-offer-refund:' || new.id::text, 'Shop offer declined — credits returned'
    );
  end if;

  return new;
end $$;

drop trigger if exists shop_orders_settle_offer on public.shop_orders;
create trigger shop_orders_settle_offer before update on public.shop_orders
  for each row execute function public.shop_settle_offer();


-- ─── Close the old door ─────────────────────────────────────────────────────
-- `requestToBuy` inserted orders straight from the client. With money attached
-- that would let a crafted insert create a delivered order — and delivery is
-- what unlocks the file in storage.
--
-- RESTRICTIVE, so it ANDs with the existing policies rather than offering an
-- alternative way in. Free claims still insert directly: they move no money, and
-- the precheck trigger already enforces the follow/like conditions server-side.
drop policy if exists "Paid orders go through the RPC" on public.shop_orders;
create policy "Paid orders go through the RPC"
  on public.shop_orders as restrictive for insert
  to authenticated
  with check (kind = 'free');


-- ─── Refund policy ──────────────────────────────────────────────────────────
-- There is deliberately no buyer-initiated refund for a DELIVERED sale. The file
-- was handed over the instant the credits moved; a refund after download is
-- indistinguishable from theft, which is why `shop_downloads.sql` logs every
-- download as dispute evidence.
--
-- It is also structurally hard: `ledger_post` refuses to settle a user account
-- negative, so once the seller has spent or withdrawn the money there is nothing
-- to claw back. Any goodwill refund should therefore come from the PLATFORM
-- account (which may go negative by design) and not from the seller:
--
--   select public.ledger_post(
--     'refund',
--     jsonb_build_array(
--       jsonb_build_object('user', null,        'kind', 'platform', 'amount_cents', -1000),
--       jsonb_build_object('user', '<buyer>',   'kind', 'credits',  'amount_cents',  1000)
--     ),
--     'manual', 'goodwill:<order_id>', 'Support refund');


-- ─── Operating it ───────────────────────────────────────────────────────────
--   select date_trunc('day', o.created_at) as day, count(*),
--          sum(o.price_cents)/100.0 as gross, sum(o.fee_cents)/100.0 as laybell
--     from public.shop_orders o
--    where o.status = 'delivered' and o.price_cents > 0
--    group by 1 order by 1 desc limit 30;
--
-- Offers stuck in escrow (seller never responded — consider auto-declining):
--   select * from public.shop_orders
--    where kind = 'offer' and status = 'requested' and created_at < now() - interval '7 days';
--
--   select * from public.ledger_verify();   -- returns rows ONLY on drift


-- ═══════════════════════════════════════════════════════════════════════════
-- FILE: supabase/sql/ledger_spend.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════════════
-- SPENDING CREDITS — tips paid from the ledger.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
-- Requires ledger.sql, donations.sql, and (for studio tips) studio_live.sql.
--
-- This is the other half of the money loop. ledger.sql defined how value is held;
-- this defines how it moves when a user actually spends it.
--
-- WHY AN RPC AND NOT CLIENT CODE
-- The client may not be trusted with any of it. Not the amount (it would send
-- whatever it liked), not the fee rate (it would send 0%), and not the decision
-- that the balance is sufficient. Every number is computed server-side from the
-- database's own state, and the ledger's own constraints refuse the write if the
-- payer can't cover it.
--
-- The old path — a bare client INSERT into donations — is what made tips
-- "conjurable": two accounts could mint a withdrawable balance at will. This
-- replaces it for BOTH livestream and studio tips.
-- ════════════════════════════════════════════════════════════════════════════

-- Laybell's cut, mirroring lib/donations.ts. Premium hosts keep more; that lower
-- rate IS the "Earn More" perk. This is the authority — the client displays a
-- rate, the server applies one, and only this one is real.
--
-- WHY PREMIUM IS 20% AND NOT THE ORIGINAL 8%. Tips are paid in credits, and
-- credits are bought through Apple and Google, who take their commission before
-- Laybell sees anything:
--
--   $10 tip: buyer paid Apple $10 → Apple keeps 15% → LAYBELL RECEIVES $8.50
--   At 8%, the creator was owed 92%                                    = $9.20
--   Laybell LOST $0.70 ON EVERY PREMIUM TIP.
--
-- Break-even is 15%. At 20% the creator keeps 80% and Laybell nets 5% — and the
-- 5% is not really the point: the tip rate is the reason to BUY Premium, and the
-- $9.99/month subscription is where Premium actually earns. "Keep 80% instead of
-- 65%" is a concrete reason to subscribe; two more points of margin is not.
--
-- 80% also beats what creators are used to: YouTube Super Thanks pays 70%,
-- Twitch's standard split is 50%, TikTok is around 50%.
--
-- Raise to 0.25 if direct margin matters more than the perk being compelling —
-- that nets 10%, matching the shop, and the creator still keeps 75%.
--
-- ⚠️ Assumes the App Store Small Business Program (15%). At the standard 30%,
-- Laybell receives $7.00 on a $10 tip and 20% would lose money again.
create or replace function public.tip_fee_rate(p_host uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select case
    when coalesce((select premium_until from public.profiles where id = p_host), 'epoch'::timestamptz) > now()
    then 0.20 else 0.35
  end;
$$;


-- ─── donation_guard v4 ──────────────────────────────────────────────────────
-- The guard trigger fires on EVERY insert into `donations` — including the one
-- tip_post_internal performs — and v3 recomputed the fee and the tax over
-- whatever it was handed. That made the donations row disagree with the ledger
-- entry created microseconds later from the same tip: the ledger moved 20%, the
-- row recorded 8%, and the row recorded a 6% tax that no ledger entry ever moved.
--
-- v4 stops deriving the fee independently and asks tip_fee_rate() instead, so
-- there is one definition of the rate. Tax is zero: tips are paid in credits,
-- and Apple and Google already collected sales tax when the credits were bought.
--
-- Everything else v3 did — resolving the host from a live stream OR a studio
-- session, rejecting self-tips, clamping the message — is preserved, because the
-- legacy insert path still relies on it.
create or replace function public.donation_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_host uuid;
begin
  if new.stream_id is not null then
    select ls.user_id into v_host from public.live_streams ls where ls.id = new.stream_id;
  elsif new.studio_session_id is not null then
    select ss.host_id into v_host from public.studio_sessions ss where ss.id = new.studio_session_id;
  end if;
  if v_host is null then raise exception 'stream_not_found'; end if;
  new.streamer_id := v_host;

  if new.donor_id = v_host then raise exception 'cannot_donate_to_self'; end if;

  new.laybell_fee_cents     := round(new.amount_cents * public.tip_fee_rate(v_host));
  new.tax_cents             := 0;
  new.streamer_payout_cents := new.amount_cents - new.laybell_fee_cents;
  new.provider              := coalesce(new.provider, 'credits');
  new.status                := coalesce(new.status, 'succeeded');
  new.processed_at          := now();
  new.message               := nullif(left(trim(coalesce(new.message, '')), 200), '');
  return new;
end; $$;


-- ─── Shared posting core ────────────────────────────────────────────────────
-- Both tip entry points funnel through here. The money logic — bounds, fee,
-- split, ledger legs — exists exactly once, so livestream and studio tips cannot
-- drift apart. Duplicating it was how studio tipping ended up still using the old
-- insecure path after livestreams were fixed.
--
-- Internal: never granted to clients. The public wrappers below resolve the host
-- from their own table and then call this.
create or replace function public.tip_post_internal(
  p_host uuid,
  p_amount_cents int,
  p_message text,
  p_stream_id uuid,
  p_studio_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_donor    uuid := auth.uid();
  v_rate     numeric;
  v_fee      int;
  v_payout   int;
  v_donation uuid;
  v_tx       uuid;
begin
  if v_donor is null then raise exception 'not_signed_in'; end if;
  if p_host is null then raise exception 'host_not_found'; end if;
  if p_host = v_donor then raise exception 'cannot_tip_self'; end if;

  -- Bounds enforced here, not in the app. $6 is the processing-economics floor
  -- (see lib/donations.ts); without a server check a crafted request could post a
  -- $0.01 tip that costs more to handle than it earns.
  if p_amount_cents < 600 or p_amount_cents > 50000 then
    raise exception 'amount_out_of_range';
  end if;

  v_rate   := public.tip_fee_rate(p_host);
  v_fee    := round(p_amount_cents * v_rate);
  v_payout := p_amount_cents - v_fee;

  -- The donation row first, so its id can key the ledger transaction — the two
  -- records point at each other and the posting gets an idempotency key.
  -- donations requires EXACTLY ONE of stream_id / studio_session_id; the wrappers
  -- pass one and null for the other.
  insert into public.donations (
    donor_id, streamer_id, stream_id, studio_session_id, amount_cents,
    laybell_fee_cents, tax_cents, streamer_payout_cents,
    provider, status, processed_at
  ) values (
    v_donor, p_host, p_stream_id, p_studio_session_id, p_amount_cents,
    v_fee, 0, v_payout,
    'credits', 'succeeded', now()
  ) returning id into v_donation;

  -- The host's earnings land behind a hold (payouts.sql → payout_hold_days).
  --
  -- An earlier version of this comment said the money was already collected when
  -- the credits were bought, so there was no chargeback window to wait out. That
  -- was wrong. The credits PURCHASE can be refunded by Apple or Google well after
  -- the fact, and `ledger_post` refuses to settle a user account negative — so a
  -- refund of already-spent credits fails and Laybell absorbs the loss with no
  -- way to claw it back. The window is on the purchase, not the tip, but it is
  -- real, and once a creator can actually withdraw it becomes a cash loss rather
  -- than a number on a screen.
  --
  -- The donor's debit and the platform fee are NOT held — only money that can
  -- leave the system needs to wait.
  v_tx := public.ledger_post(
    'tip',
    jsonb_build_array(
      jsonb_build_object('user', v_donor, 'kind', 'credits',  'amount_cents', -p_amount_cents),
      jsonb_build_object('user', p_host,  'kind', 'earnings', 'amount_cents',  v_payout,
                         'available_at', now() + (public.payout_hold_days() || ' days')::interval),
      jsonb_build_object('user', null,    'kind', 'platform', 'amount_cents',  v_fee)
    ),
    'internal',
    'tip:' || v_donation::text,
    coalesce(nullif(p_message, ''), 'Live tip')
  );

  return jsonb_build_object(
    'ok', true,
    'donation_id', v_donation,
    'transaction_id', v_tx,
    'amount_cents', p_amount_cents,
    'fee_cents', v_fee,
    'payout_cents', v_payout
  );
end $$;

revoke all on function public.tip_post_internal(uuid, int, text, uuid, uuid) from public, authenticated;


-- ─── Tip a LIVESTREAM host ──────────────────────────────────────────────────
create or replace function public.tip_with_credits(
  p_stream_id uuid,
  p_amount_cents int,
  p_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_host uuid;
begin
  select user_id into v_host from public.live_streams where id = p_stream_id;
  if v_host is null then raise exception 'stream_not_found'; end if;
  return public.tip_post_internal(v_host, p_amount_cents, p_message, p_stream_id, null);
end $$;

grant execute on function public.tip_with_credits(uuid, int, text) to authenticated;


-- ─── Tip a LIVE STUDIO host ─────────────────────────────────────────────────
-- The gap this closes: studio tips previously took the old client-INSERT path,
-- so they were still conjurable after livestream tips were secured. Same three
-- legs, same fee logic — only the host lookup differs.
create or replace function public.tip_studio_with_credits(
  p_session_id uuid,
  p_amount_cents int,
  p_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_host uuid;
begin
  select host_id into v_host from public.studio_sessions where id = p_session_id;
  if v_host is null then raise exception 'session_not_found'; end if;
  return public.tip_post_internal(v_host, p_amount_cents, p_message, null, p_session_id);
end $$;

grant execute on function public.tip_studio_with_credits(uuid, int, text) to authenticated;

grant execute on function public.tip_fee_rate(uuid) to authenticated;


-- ─── Note: insufficient balance ─────────────────────────────────────────────
-- Not checked explicitly, and that is deliberate. ledger_post refuses to settle a
-- user account below zero and raises 'insufficient funds'. Duplicating the check
-- here would introduce a second source of truth that could drift from the first,
-- and it would still race — the ledger's constraint is inside the transaction,
-- any check here would not be. Let the ledger be the authority and translate its
-- error in the client.


-- ─── Lock the old path shut ─────────────────────────────────────────────────
-- Both tip routes now go through the RPCs above, so a direct client INSERT into
-- donations should no longer be possible. This restrictive policy ANDs with the
-- existing permissive ones: rows may still be created by the SECURITY DEFINER
-- functions (they run as the owner and bypass RLS), but not by a client.
--
-- Without this, closing the studio hole in code would leave the hole open in the
-- database — anyone with the anon key could keep inserting donations directly.
do $$
begin
  if to_regclass('public.donations') is null then return; end if;
  execute $p$
    drop policy if exists "Donations are created server-side only" on public.donations;
  $p$;
  execute $p$
    create policy "Donations are created server-side only"
      on public.donations as restrictive for insert
      with check (false);
  $p$;
end $$;


-- ─── Not built yet: shop purchases ──────────────────────────────────────────
-- Paying for Shop listings with credits is deliberately NOT included, because it
-- is not merely a technical step. Today the Shop is a VENUE: the app tells buyers
-- "Laybell doesn't process payments — you arrange payment with the seller", and
-- Laybell never touches the money.
--
-- Routing Shop payments through credits makes Laybell the one collecting and
-- remitting, which very likely makes it a MARKETPLACE FACILITATOR — sales-tax
-- collection and monthly filing (Maryland taxes digital products at 6%), plus
-- 1099 reporting for sellers.
--
-- That is a business decision with real recurring cost, not a code change.
-- See docs/LAUNCH_CHECKLIST.md §6.6.


-- Verify after running:
--   select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname='public' and proname like 'tip%';
--   -- expect: tip_fee_rate, tip_post_internal, tip_studio_with_credits, tip_with_credits
