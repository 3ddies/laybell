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
