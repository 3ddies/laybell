-- SHOP REFUND CLAWBACK — recover the seller's earnings when a card sale is refunded.
-- Run AFTER shop_stripe.sql + shop_stripe_cart.sql. Idempotent; re-runnable.
-- ⚠️ MONEY CODE — DO NOT RUN until reviewed + owner-approved. Changes a documented policy.
--
-- THE PROBLEM THIS FIXES
-- On a Stripe `charge.refunded`, shop_stripe_refund_delivered revokes file access and
-- returns the tax to the buyer, but it does NOT reverse the SELLER's earnings ledger
-- entry. The in-code rationale ("the ledger refuses a negative user balance once
-- withdrawn") is only true for the tail case: a refund that arrives AFTER the 14-day
-- payout hold (payout_hold_days() = 14) AND after the seller actually cashed out.
--
-- In the common case the refund lands INSIDE the 14-day hold, while the seller's
-- earnings are still FROZEN (available_at in the future) and therefore fully clawable.
-- Leaving them on the books means: the buyer is refunded via Stripe, yet the seller can
-- still withdraw ~70% of the sale price — a real, per-refund loss to the platform
-- (e.g. $10.49 on a $14.99 lease; ~$91 on a $129.99 exclusive).
--
-- WHAT THIS DOES (per refunded order)
--   • If the seller's earnings balance covers the payout (the common, in-hold case):
--     post a balanced compensating `refund` ledger tx that negates the original sale's
--     three legs → the seller's earnings and the platform legs return to pre-sale. No loss.
--   • If it does NOT cover it (seller already withdrew — the rare tail): do exactly what
--     happens today (platform absorbs the loss — there is no honest ledger entry that can
--     manufacture the money back), but RECORD the shortfall in shop_refund_shortfalls so
--     it is visible + reconcilable instead of silent.
--   • NEVER fails the webhook closed: the external refund already happened, so a clawback
--     hiccup must not wedge Stripe into infinite retries. Only a genuine insufficiency is
--     absorbed; any other error re-raises so Stripe retries (idempotent → safe).
--   • Idempotent per order (ledger external_id 'shop-refund:<order>'), cart-aware (loops
--     each order with ITS OWN seller + fee), and uses each order's STORED fee_cents — so a
--     later fee-rate change (e.g. the SBP flip) can never desync the reversal from the
--     original earnings leg.
--
-- Reversible by flipping shop_refund_clawback_enabled() back to `false` (no redeploy of
-- callers needed) — then it behaves exactly like today.

do $$
begin
  if not exists (select 1 from information_schema.tables
                  where table_schema = 'public' and table_name = 'shop_stripe_carts') then
    raise exception 'run shop_stripe_cart.sql before shop_refund_clawback.sql (this replaces the cart-aware refund fn)';
  end if;
end $$;


-- ─── 0) Rollout toggle ──────────────────────────────────────────────────────
-- Default ON (you are opting in by running this file). To revert to the old
-- "seller keeps earnings" behavior without redeploying callers, redefine this to
-- `select false`.
create or replace function public.shop_refund_clawback_enabled()
returns boolean language sql immutable as $$ select true $$;


-- ─── 1) Shortfall ledger (the rare, un-clawable tail — made visible) ─────────
create table if not exists public.shop_refund_shortfalls (
  order_id     uuid primary key references public.shop_orders(id) on delete cascade,
  seller_id    uuid,
  amount_cents bigint not null,
  reason       text,
  created_at   timestamptz not null default now()
);
-- Service-role / SQL-editor only (owner reconciliation tooling). No app role touches it.
alter table public.shop_refund_shortfalls enable row level security;


-- ─── 2) Per-order clawback helper ───────────────────────────────────────────
-- Reverses ONE delivered order's seller earnings (+ platform legs) if coverable, else
-- records the shortfall. Call it while the order is still 'delivered' (before the status
-- flip). Idempotent: a prior 'shop-refund:<order>' tx short-circuits it.
create or replace function public.shop_refund_clawback_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  o        public.shop_orders%rowtype;
  v_payout bigint;
  v_bal    bigint;
begin
  if not public.shop_refund_clawback_enabled() then return; end if;

  select * into o from public.shop_orders where id = p_order_id;
  -- Only a still-delivered, paid order is clawable (callers run this BEFORE the status flip).
  if o.id is null or o.status <> 'delivered' or coalesce(o.price_cents, 0) <= 0 then return; end if;

  v_payout := o.price_cents - coalesce(o.fee_cents, 0);                    -- STORED fee, not recomputed
  if v_payout <= 0 then return; end if;

  -- Idempotency: never reverse the same order's sale twice.
  if exists (select 1 from public.ledger_transactions
              where source = 'stripe' and external_id = 'shop-refund:' || p_order_id::text) then
    return;
  end if;

  -- The seller's maintained earnings balance (TOTAL — includes money still on hold).
  select coalesce(balance_cents, 0) into v_bal from public.ledger_accounts
    where user_id = o.seller_id and kind = 'earnings' and currency = 'USD';

  if coalesce(v_bal, 0) >= v_payout then
    -- Common, in-hold case: negate the original sale's three legs exactly.
    --   delivery posted: earnings +payout, platform +fee, platform -price
    --   reversal posts : earnings -payout, platform -fee, platform +price   (sums to 0)
    -- Wrapped in a subtransaction so a RACE (balance drained between the read above and
    -- the post) is absorbed rather than wedging the refund webhook; any OTHER error
    -- re-raises (Stripe retries — the external_id keeps that idempotent).
    begin
      perform public.ledger_post(
        'refund',
        jsonb_build_array(
          jsonb_build_object('user', o.seller_id, 'kind', 'earnings', 'amount_cents', -v_payout),
          jsonb_build_object('user', null,        'kind', 'platform', 'amount_cents', -coalesce(o.fee_cents, 0)),
          jsonb_build_object('user', null,        'kind', 'platform', 'amount_cents', o.price_cents)
        ),
        'stripe', 'shop-refund:' || p_order_id::text, 'Card refund — seller earnings clawed back'
      );
    exception when others then
      if sqlerrm like 'insufficient funds%' then
        -- The read was racy; treat as the un-clawable tail.
        insert into public.shop_refund_shortfalls (order_id, seller_id, amount_cents, reason)
          values (p_order_id, o.seller_id, v_payout, 'insufficient_balance_race')
          on conflict (order_id) do nothing;
      else
        raise;  -- a real error — let the webhook 5xx so Stripe retries
      end if;
    end;
  else
    -- Rare tail: seller already withdrew. Platform absorbs (as today) — but recorded.
    insert into public.shop_refund_shortfalls (order_id, seller_id, amount_cents, reason)
      values (p_order_id, o.seller_id, v_payout, 'insufficient_balance')
      on conflict (order_id) do nothing;
  end if;
end $$;

revoke all on function public.shop_refund_clawback_order(uuid) from public, anon, authenticated;


-- ─── 3) Replace the cart-aware charge.refunded handler to claw back first ────
-- Identical to the shop_stripe_cart.sql version, except it claws back each delivered
-- order's earnings (via the helper) BEFORE flipping the order(s) to 'refunded'.
create or replace function public.shop_stripe_refund_delivered(p_payment_intent_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pay public.shop_stripe_payments%rowtype;
  v_n   int := 0;
  r     record;
begin
  if p_payment_intent_id is null then return jsonb_build_object('ok', false, 'reason', 'no_pi'); end if;
  select * into v_pay from public.shop_stripe_payments
    where payment_intent_id = p_payment_intent_id order by created_at desc limit 1;
  if v_pay.id is null then return jsonb_build_object('ok', false, 'reason', 'payment_not_found'); end if;
  -- Idempotent: a retried charge.refunded (or an already-failed/refunded payment) does nothing.
  if v_pay.outcome <> 'delivered' then return jsonb_build_object('ok', true, 'noop', true); end if;

  if v_pay.cart_id is not null then
    -- Cart: claw back every delivered order, then revoke them all + reverse tax.
    for r in
      select o.id from public.shop_orders o
       where o.id in (select order_id from public.shop_stripe_intents
                       where cart_id = v_pay.cart_id and order_id is not null)
         and o.status = 'delivered'
    loop
      perform public.shop_refund_clawback_order(r.id);
    end loop;

    update public.shop_orders set status = 'refunded', refunded_at = now()
     where id in (select order_id from public.shop_stripe_intents
                   where cart_id = v_pay.cart_id and order_id is not null)
       and status = 'delivered';
    get diagnostics v_n = row_count;
    update public.shop_tax_collected set reversed_at = now()
     where cart_id = v_pay.cart_id and reversed_at is null;
    update public.shop_stripe_payments set outcome = 'refunded' where id = v_pay.id;
    return jsonb_build_object('ok', true, 'revoked', true, 'cart', true, 'orders', v_n);
  end if;

  -- Single order.
  if v_pay.order_id is not null then
    perform public.shop_refund_clawback_order(v_pay.order_id);
    update public.shop_orders set status = 'refunded', refunded_at = now()
     where id = v_pay.order_id and status = 'delivered';
    update public.shop_stripe_payments set outcome = 'refunded' where id = v_pay.id;
    update public.shop_tax_collected set reversed_at = now()
     where order_id = v_pay.order_id and reversed_at is null;
    return jsonb_build_object('ok', true, 'revoked', true, 'order_id', v_pay.order_id);
  end if;

  -- Payment with no order (shouldn't happen for a delivered outcome) — just settle it.
  update public.shop_stripe_payments set outcome = 'refunded' where id = v_pay.id;
  return jsonb_build_object('ok', true, 'noop', true);
end $$;

revoke all on function public.shop_stripe_refund_delivered(text) from public, anon, authenticated;


-- ─── Checking it ────────────────────────────────────────────────────────────
--   Global solvency unchanged:            select * from public.ledger_verify();      -- expect 0 rows
--   Every refunded card sale has a reversal OR a recorded shortfall (expect 0 rows):
--     select o.id from public.shop_orders o
--       join public.shop_stripe_payments p on p.order_id = o.id and p.outcome='refunded'
--      where o.price_cents > 0
--        and not exists (select 1 from public.ledger_transactions
--                         where source='stripe' and external_id='shop-refund:'||o.id::text)
--        and not exists (select 1 from public.shop_refund_shortfalls s where s.order_id=o.id);
--   The un-clawable tail to reconcile by hand: select * from public.shop_refund_shortfalls;
--
-- Rollback:
--   -- restore the cart-aware version from shop_stripe_cart.sql (re-run that file), then:
--   drop function if exists public.shop_refund_clawback_order(uuid);
--   drop function if exists public.shop_refund_clawback_enabled();
--   -- shop_refund_shortfalls is additive; safe to leave (or drop if empty).
