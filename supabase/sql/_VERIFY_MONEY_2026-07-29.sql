-- FINAL money verification — everything applied on 2026-07-29.
-- Paste into the Supabase SQL Editor. Reads only; changes nothing.
--
-- Run this whenever you want to confirm the database still matches the code,
-- and ALWAYS after re-running any money file. It reports as an error even on a
-- clean pass — raising is the only way the report survives the rollback.

do $$
declare
  fails text[] := '{}';
  passes int := 0;
  n int; r numeric; v_uid uuid;
begin
  -- ── Rates ─────────────────────────────────────────────────────────────────
  execute 'select public.shop_fee_rate()' into r;
  if r <> 0.30 then fails := fails || format('shop fee %s, expected 0.30', r); else passes := passes + 1; end if;

  execute 'select public.tip_fee_rate(null::uuid)' into r;
  if r <> 0.35 then fails := fails || format('standard tip fee %s, expected 0.35', r); else passes := passes + 1; end if;

  if not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='tip_fee_rate'
                    and pg_get_functiondef(p.oid) like '%0.30%')
    then fails := fails || 'Premium tip rate is not 0.30 — _RUN_RATES not applied';
    else passes := passes + 1; end if;

  -- delivered_earnings must DERIVE the rate, not hardcode it. It said 0.85 for a
  -- 15% fee and stayed 0.85 when the fee became 30%, overstating every seller's
  -- earnings by 15 points of gross.
  if not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='delivered_earnings'
                    and pg_get_functiondef(p.oid) like '%shop_fee_rate%')
    then fails := fails || 'delivered_earnings still hardcodes a rate — re-run wallet_earnings.sql';
    else passes := passes + 1; end if;

  execute 'select public.payout_min_cents()'   into n;
  if n <> 2500 then fails := fails || 'payout minimum wrong'; else passes := passes + 1; end if;
  execute 'select public.payout_hold_days()'   into n;
  if n <> 14   then fails := fails || 'payout hold wrong';    else passes := passes + 1; end if;
  execute 'select public.ad_min_budget_cents()' into n;
  if n <> 500  then fails := fails || 'ad minimum wrong';     else passes := passes + 1; end if;

  -- ── C2: anon must not execute ANY money function ──────────────────────────
  -- Supabase's default privileges grant EXECUTE to anon explicitly, so revoking
  -- from `public` and `authenticated` alone leaves the app's shipped anon key
  -- able to call ledger_post directly with no JWT.
  for n in
    select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.proname in ('ledger_post','ledger_account','ledger_verify','settle_payout',
                         'tip_post_internal','request_payout','shop_buy_with_credits',
                         'spotlight_buy_with_credits','ad_campaign_fund_with_credits',
                         'ad_campaign_end','refund_and_remove_listing')
       and has_function_privilege('anon', p.oid, 'execute')
  loop
    fails := fails || 'ANON CAN EXECUTE A MONEY FUNCTION — re-run money_hardening_2026-07-29.sql';
    exit;
  end loop;
  if array_length(fails,1) is null or not (fails @> array['ANON CAN EXECUTE A MONEY FUNCTION — re-run money_hardening_2026-07-29.sql'])
    then passes := passes + 1; end if;

  -- ── C1: the offer settle must read the ESCROW, not the row ────────────────
  if not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='shop_settle_offer'
                    and pg_get_functiondef(p.oid) like '%shop-offer:%')
    then fails := fails || 'shop_settle_offer still trusts new.price_cents — MONEY CAN BE MINTED';
    else passes := passes + 1; end if;

  -- ── Guards present ────────────────────────────────────────────────────────
  if not exists (select 1 from pg_trigger where tgname = 'shop_orders_z_guard')
    then fails := fails || 'shop_orders_z_guard MISSING — order columns are mutable';
    else passes := passes + 1; end if;
  if not exists (select 1 from pg_trigger where tgname = 'ad_campaigns_guard_trg')
    then fails := fails || 'ad_campaigns_guard_trg MISSING'; else passes := passes + 1; end if;

  -- Spend monotonic, not frozen — frozen throws on every ad impression.
  if not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='ad_campaigns_guard'
                    and pg_get_functiondef(p.oid) like '%spent_millicents < old.spent_millicents%')
    then fails := fails || 'ad guard freezes spend — EVERY AD IMPRESSION WILL THROW';
    else passes := passes + 1; end if;

  -- post_id and kind must be protected, or $5 buys a year-long Spotlight.
  if not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='ad_campaigns_guard'
                    and pg_get_functiondef(p.oid) like '%post_id          is distinct from old.post_id%')
    then fails := fails || 'ad guard does not protect post_id — re-run money_hardening';
    else passes := passes + 1; end if;

  -- ── H1: takedowns must actually refund ────────────────────────────────────
  if not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='refund_and_remove_listing'
                    and pg_get_functiondef(p.oid) like '%ledger_post%')
    then fails := fails || 'refund_and_remove_listing posts no reversal — buyers lose file AND credits';
    else passes := passes + 1; end if;

  -- ── H2: ending an ad must refund from ''ended'' too ───────────────────────
  if not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='ad_campaign_end'
                    and pg_get_functiondef(p.oid) like '%''ended''%')
    then fails := fails || 'ad_campaign_end will not refund an already-ended campaign';
    else passes := passes + 1; end if;

  -- ── Preconditions ─────────────────────────────────────────────────────────
  -- donation_guard reads new.studio_session_id; without studio_live.sql EVERY
  -- tip raises.
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='donations'
                    and column_name='studio_session_id')
    then fails := fails || 'donations.studio_session_id MISSING — every tip will fail';
    else passes := passes + 1; end if;

  -- Offers created before credits existed carry no escrow. They are now ignored
  -- rather than minting money, but they will never settle either.
  select count(*) into n from public.shop_orders
   where kind = 'offer' and status = 'requested'
     and not exists (select 1 from public.ledger_transactions t
                      where t.source='internal' and t.external_id = 'shop-offer:' || shop_orders.id::text);
  if n > 0 then fails := fails || format('%s un-escrowed offer(s) pending — clear them by hand', n);
  else passes := passes + 1; end if;

  -- ── The books balance ─────────────────────────────────────────────────────
  select count(*) into n from public.ledger_verify();
  if n > 0 then fails := fails || format('LEDGER DRIFT on %s account(s)', n); else passes := passes + 1; end if;

  if array_length(fails, 1) is null then
    raise exception E'\n\n  ALL % MONEY CHECKS PASSED.\n\n  Rates, guards, refunds and privileges all match the code.\n', passes;
  else
    raise exception E'\n\n  % passed, % FAILED:\n\n  - %\n', passes, array_length(fails,1), array_to_string(fails, E'\n  - ');
  end if;
end $$;
