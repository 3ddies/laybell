-- SHOP CHARGEBACK (card dispute) handling — visibility log + a recorder fn.
-- Run AFTER shop_stripe.sql + shop_stripe_cart.sql + shop_refund_clawback.sql. Idempotent; re-runnable.
--
-- ⚠️ MONEY-ADJACENT, NOT MONEY-MOVING. The actual money reversal on a chargeback REUSES
-- shop_stripe_refund_delivered (the audited, clawback-enhanced refund path) — the webhook routes
-- charge.dispute.created through it. This file adds ONLY a non-money AUDIT table + its recorder.
-- There is deliberately NO ledger write here.
--
-- WHY A CHARGEBACK IS HANDLED LIKE A REFUND (the money reasoning)
-- When a buyer disputes a card charge, Stripe immediately pulls the funds back out of the
-- platform's Stripe balance (the gross price PLUS a ~$15 dispute fee) and emits
-- charge.dispute.created; weeks later charge.dispute.closed carries won|lost. For a digital beat
-- the file is already downloaded, so the platform will almost always lose the dispute. The money
-- danger is NOT the chargeback itself (unavoidable) — it is paying the seller their 70% ON TOP of
-- eating the chargeback. So on dispute.created we do exactly what a refund does: revoke the
-- download and claw the seller's earnings back (via shop_stripe_refund_delivered, idempotent per
-- order). The platform still eats the gross + fee from its Stripe balance; it simply does not ALSO
-- gift the seller their cut. A later 'won' is the rare exception and is logged for a MANUAL
-- re-credit — a re-credit is the only mint-direction action and never happens automatically.
--
-- WHAT THIS GIVES THE OWNER
-- One row per dispute, so chargebacks are visible + reconcilable (which PI, how much, Stripe's
-- reason, the current status, and whether we clawed the seller back) — the same visibility posture
-- as shop_refund_shortfalls.

do $$
begin
  if not exists (select 1 from pg_proc where proname = 'shop_stripe_refund_delivered') then
    raise exception 'run shop_stripe.sql (+ shop_stripe_cart.sql + shop_refund_clawback.sql) before shop_chargeback.sql';
  end if;
end $$;


-- ─── 1) Disputes audit log (NOT a money table) ──────────────────────────────
create table if not exists public.shop_disputes (
  dispute_id        text primary key,            -- Stripe dispute id (dp_…)
  payment_intent_id text,                         -- what the reversal is matched on
  charge_id         text,
  amount_cents      bigint,                        -- Stripe's disputed amount
  currency          text,
  reason            text,                          -- Stripe's dispute reason (fraudulent, product_not_received, …)
  status            text,                          -- warning_needs_response | needs_response | under_review | won | lost | …
  -- Did the open-event successfully revoke + claw back the matching order(s)? (false when the
  -- dispute carried no payment_intent or no delivered order was found.)
  clawed_back       boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
-- Service-role / SQL-editor only (owner reconciliation tooling). No app role, no RLS policy.
alter table public.shop_disputes enable row level security;


-- ─── 2) Recorder (upsert) — service role only, NO money movement ────────────
-- Called by the stripe-webhook on charge.dispute.created and charge.dispute.closed. Pure audit:
-- inserts on first sight, updates the status/clawed flag on later events for the same dispute.
create or replace function public.shop_record_dispute(
  p_dispute_id        text,
  p_payment_intent_id text,
  p_charge_id         text,
  p_amount_cents      bigint,
  p_currency          text,
  p_reason            text,
  p_status            text,
  p_clawed_back       boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_dispute_id is null then return; end if;
  insert into public.shop_disputes
    (dispute_id, payment_intent_id, charge_id, amount_cents, currency, reason, status, clawed_back)
  values (p_dispute_id, p_payment_intent_id, p_charge_id, p_amount_cents,
          lower(nullif(p_currency, '')), p_reason, p_status, coalesce(p_clawed_back, false))
  on conflict (dispute_id) do update
    set status            = coalesce(excluded.status, public.shop_disputes.status),
        reason            = coalesce(excluded.reason, public.shop_disputes.reason),
        payment_intent_id = coalesce(excluded.payment_intent_id, public.shop_disputes.payment_intent_id),
        charge_id         = coalesce(excluded.charge_id, public.shop_disputes.charge_id),
        amount_cents      = coalesce(excluded.amount_cents, public.shop_disputes.amount_cents),
        -- once clawed, stays clawed (a later status event never un-sets it)
        clawed_back       = public.shop_disputes.clawed_back or excluded.clawed_back,
        updated_at        = now();
end $$;

revoke all on function public.shop_record_dispute(text, text, text, bigint, text, text, text, boolean)
  from public, anon, authenticated;


-- ─── Checking it ────────────────────────────────────────────────────────────
--   Open disputes still owed a response / review:
--     select * from public.shop_disputes where status not in ('won','lost') order by created_at desc;
--   Disputes we WON after clawing the seller back (a manual re-credit + re-grant may be owed):
--     select * from public.shop_disputes where status = 'won' and clawed_back;
--   The money reversal itself lives in the ledger (one 'refund' tx per clawed order):
--     select * from public.ledger_transactions where source='stripe' and external_id like 'shop-refund:%';
--   Global solvency unchanged (this file moves no money): select * from public.ledger_verify();  -- 0 rows
--
-- Rollback:
--   drop function if exists public.shop_record_dispute(text,text,text,bigint,text,text,text,boolean);
--   drop table if exists public.shop_disputes;
