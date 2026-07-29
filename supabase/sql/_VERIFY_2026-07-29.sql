-- Verification for _RUN_2026-07-29.sql
-- Paste into the Supabase SQL Editor and run. Safe: reads only, changes nothing.
--
-- WHY IT IS ONE do$$ BLOCK. Supabase's SQL editor pools connections, so TEMP
-- TABLES DO NOT SURVIVE between statements — the obvious "collect results into a
-- temp table, then select it" approach fails with "relation does not exist".
-- Raising at the end puts the whole report in the error message instead, which
-- is also why a PASS run reports itself as an error. That is expected.
--
-- The reason this exists at all: a previous run failed partway through, rolled
-- back, and only one of three files got re-applied. Everything looked fine.
-- "It ran without errors" is not the same as "it is all there."

do $$
declare
  fails  text[] := '{}';
  passes int := 0;
  n      int;
  r      numeric;

  procedure_missing text;
begin
  -- ── 1. geo_block ──────────────────────────────────────────────────────────
  if to_regclass('public.blocked_regions') is null
    then fails := fails || 'blocked_regions table MISSING'; else passes := passes + 1; end if;

  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='profiles'
     and column_name in ('region_code','region_blocked_at');
  if n <> 2 then fails := fails || format('profiles region columns: %s/2', n); else passes := passes + 1; end if;

  if to_regprocedure('public.set_region(text)') is null
    then fails := fails || 'set_region() MISSING'; else passes := passes + 1; end if;
  if to_regprocedure('public.in_blocked_region()') is null
    then fails := fails || 'in_blocked_region() MISSING'; else passes := passes + 1; end if;

  begin
    if not exists (select 1 from public.blocked_regions br where br.region_code = 'MS')
      then fails := fails || 'Mississippi NOT in blocked_regions'; else passes := passes + 1; end if;
  exception when others then fails := fails || 'blocked_regions unreadable'; end;

  select count(*) into n from pg_policies
   where schemaname='public' and policyname like 'Blocked regions%';
  if n < 3 then fails := fails || format('blocked-region RLS policies: %s/3', n); else passes := passes + 1; end if;

  -- ── 2. mlc_meter ──────────────────────────────────────────────────────────
  if to_regprocedure('public.mlc_usage(date,bigint,bigint)') is null
    then fails := fails || 'mlc_usage() MISSING'; else passes := passes + 1; end if;
  if to_regprocedure('public.mlc_usage_trend(int)') is null
    then fails := fails || 'mlc_usage_trend() MISSING'; else passes := passes + 1; end if;

  -- ── 3. payouts ────────────────────────────────────────────────────────────
  if to_regclass('public.payouts') is null
    then fails := fails || 'payouts table MISSING'; else passes := passes + 1; end if;

  if to_regprocedure('public.payout_min_cents()') is null then
    fails := fails || 'payout_min_cents() MISSING';
  else
    execute 'select public.payout_min_cents()' into n;
    if n <> 2500 then fails := fails || format('payout minimum is %s, expected 2500', n);
    else passes := passes + 1; end if;
  end if;

  if to_regprocedure('public.payout_hold_days()') is null then
    fails := fails || 'payout_hold_days() MISSING — ledger_spend will fail without it';
  else
    execute 'select public.payout_hold_days()' into n;
    if n <> 14 then fails := fails || format('payout hold is %s days, expected 14', n);
    else passes := passes + 1; end if;
  end if;

  if to_regprocedure('public.request_payout(bigint)') is null
    then fails := fails || 'request_payout() MISSING'; else passes := passes + 1; end if;
  if to_regprocedure('public.settle_payout(uuid,text,text,text)') is null
    then fails := fails || 'settle_payout() MISSING'; else passes := passes + 1; end if;
  if to_regprocedure('public.payout_available_cents()') is null
    then fails := fails || 'payout_available_cents() MISSING'; else passes := passes + 1; end if;

  -- One pending payout per user is the double-submit guard.
  if not exists (select 1 from pg_indexes where schemaname='public' and indexname='payouts_one_pending_idx')
    then fails := fails || 'payouts_one_pending_idx MISSING (double-submit guard)'; else passes := passes + 1; end if;

  -- ── 4. shop_credits ───────────────────────────────────────────────────────
  if to_regprocedure('public.shop_fee_rate()') is null then
    fails := fails || 'shop_fee_rate() MISSING';
  else
    execute 'select public.shop_fee_rate()' into r;
    if r <> 0.25 then fails := fails || format('shop fee is %s, expected 0.25', r);
    else passes := passes + 1; end if;
  end if;

  if to_regprocedure('public.shop_buy_with_credits(uuid,text,int)') is null
    then fails := fails || 'shop_buy_with_credits() MISSING'; else passes := passes + 1; end if;

  if not exists (select 1 from pg_trigger where tgname = 'shop_orders_settle_offer')
    then fails := fails || 'shop_orders_settle_offer trigger MISSING (offers would never refund)';
    else passes := passes + 1; end if;

  if not exists (select 1 from pg_policies
                  where schemaname='public' and tablename='shop_orders'
                    and policyname='Paid orders go through the RPC')
    then fails := fails || 'shop_orders restrictive insert policy MISSING (clients could self-deliver)';
    else passes := passes + 1; end if;

  -- ── 5. ledger_spend re-run ────────────────────────────────────────────────
  -- The whole point of re-running it. If these fail, ledger_spend either wasn't
  -- re-run or was run BEFORE payouts.sql and errored on payout_hold_days().
  if to_regprocedure('public.tip_fee_rate(uuid)') is null then
    fails := fails || 'tip_fee_rate() MISSING';
  else
    -- A null host is not Premium, so this is the standard rate.
    execute 'select public.tip_fee_rate(null::uuid)' into r;
    if r <> 0.35 then fails := fails || format('standard tip fee is %s, expected 0.35', r);
    else passes := passes + 1; end if;
  end if;

  -- Premium rate + the hold + donation_guard v4 are all read out of the stored
  -- function bodies: cheaper than constructing a Premium user to test against.
  if not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='tip_fee_rate'
                    and pg_get_functiondef(p.oid) like '%0.20%')
    then fails := fails || 'tip_fee_rate still on the OLD 8% Premium rate — ledger_spend not re-run';
    else passes := passes + 1; end if;

  if not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='tip_post_internal'
                    and pg_get_functiondef(p.oid) like '%available_at%')
    then fails := fails || 'tip_post_internal has NO hold — ledger_spend not re-run';
    else passes := passes + 1; end if;

  if not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='donation_guard'
                    and pg_get_functiondef(p.oid) like '%tip_fee_rate%')
    then fails := fails || 'donation_guard is still v3 — it will overwrite the fee and re-add the 6% tax';
    else passes := passes + 1; end if;

  -- ── 6. The books still balance ────────────────────────────────────────────
  begin
    select count(*) into n from public.ledger_verify();
    if n > 0 then fails := fails || format('LEDGER DRIFT on %s account(s) — run select * from public.ledger_verify()', n);
    else passes := passes + 1; end if;
  exception when others then fails := fails || 'ledger_verify() could not run'; end;

  -- ── Report ────────────────────────────────────────────────────────────────
  if array_length(fails, 1) is null then
    raise exception E'\n\n  ALL % CHECKS PASSED.\n\n  Everything in _RUN_2026-07-29.sql is applied.\n  (This reports as an error only so the results survive the rollback.)\n', passes;
  else
    raise exception E'\n\n  % passed, % FAILED:\n\n  - %\n\n  Re-run _RUN_2026-07-29.sql from the top. It is idempotent.\n',
      passes, array_length(fails, 1), array_to_string(fails, E'\n  - ');
  end if;
end $$;
