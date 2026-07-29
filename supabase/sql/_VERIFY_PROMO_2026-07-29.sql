-- Verification for promo_credits.sql
-- Paste into the Supabase SQL Editor and run AFTER promo_credits.sql.
--
-- This one doesn't just check that objects exist — it ATTEMPTS THE THREE
-- EXPLOITS and fails if any of them succeeds. Everything runs inside a block
-- that raises at the end, so nothing it writes survives. (A pass reports itself
-- as an error; that is how the report escapes the rollback.)

do $$
declare
  fails  text[] := '{}';
  passes int := 0;
  n int;
  v_uid uuid;
begin
  -- ── Prices and limits are server-side ─────────────────────────────────────
  if to_regprocedure('public.spotlight_package(text)') is null then
    fails := fails || 'spotlight_package() MISSING';
  else
    select price_cents into n from public.spotlight_package('7d');
    if n is distinct from 4999 then fails := fails || format('7d package is %s, expected 4999', n);
    else passes := passes + 1; end if;
    select price_cents into n from public.spotlight_package('12h');
    if n is distinct from 599 then fails := fails || format('12h package is %s, expected 599', n);
    else passes := passes + 1; end if;
  end if;

  if to_regprocedure('public.ad_min_budget_cents()') is null then
    fails := fails || 'ad_min_budget_cents() MISSING';
  else
    execute 'select public.ad_min_budget_cents()' into n;
    if n <> 500 then fails := fails || format('ad minimum is %s, expected 500', n); else passes := passes + 1; end if;
  end if;

  if to_regprocedure('public.ad_default_cpm_cents()') is null then
    fails := fails || 'ad_default_cpm_cents() MISSING';
  else
    execute 'select public.ad_default_cpm_cents()' into n;
    if n <> 1000 then fails := fails || format('default CPM is %s, expected 1000', n); else passes := passes + 1; end if;
  end if;

  -- ── The RPCs exist ────────────────────────────────────────────────────────
  if to_regprocedure('public.spotlight_buy_with_credits(text)') is null
    then fails := fails || 'spotlight_buy_with_credits() MISSING'; else passes := passes + 1; end if;
  if to_regprocedure('public.spotlight_activate(uuid,uuid)') is null
    then fails := fails || 'spotlight_activate() MISSING'; else passes := passes + 1; end if;
  if to_regprocedure('public.spotlight_cancel_pending(uuid)') is null
    then fails := fails || 'spotlight_cancel_pending() MISSING'; else passes := passes + 1; end if;
  if to_regprocedure('public.ad_campaign_fund_with_credits(uuid,int)') is null
    then fails := fails || 'ad_campaign_fund_with_credits() MISSING'; else passes := passes + 1; end if;
  if to_regprocedure('public.ad_campaign_end(uuid)') is null
    then fails := fails || 'ad_campaign_end() MISSING'; else passes := passes + 1; end if;

  if not exists (select 1 from pg_trigger where tgname = 'ad_campaigns_guard_trg')
    then fails := fails || 'ad_campaigns_guard_trg MISSING — every hole below is still open';
    else passes := passes + 1; end if;

  -- The guard must allow spend to RISE. Its first version froze spent_millicents
  -- outright, which would have thrown on every ad impression: record_ad_event
  -- accrues spend and knows nothing about the trusted flag. Ad metering would
  -- have been silently dead, and only visible as ads that never stop serving.
  if not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='ad_campaigns_guard'
                    and pg_get_functiondef(p.oid) like '%spent_millicents < old.spent_millicents%')
    then fails := fails || 'ad_campaigns_guard freezes spend instead of requiring it to be monotonic — EVERY AD IMPRESSION WILL THROW. Re-run promo_credits.sql.';
    else passes := passes + 1; end if;

  -- The Premium free spotlight must have been redefined to set the trusted flag,
  -- or the guard rejects its legitimate $0 insert.
  if not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='claim_free_spotlight'
                    and pg_get_functiondef(p.oid) like '%promo_trusted%')
    then fails := fails || 'claim_free_spotlight not updated — the Premium free Spotlight will fail';
    else passes := passes + 1; end if;

  -- ── EXPLOIT 1: mint a live $0 Spotlight ───────────────────────────────────
  select id into v_uid from auth.users limit 1;
  if v_uid is null then
    fails := fails || 'no users to test against — skipped the exploit checks';
  else
    begin
      insert into public.ad_campaigns (user_id, kind, status, price_cents, weight, ends_at)
      values (v_uid, 'spotlight', 'active', 0, 10, now() + interval '365 days');
      fails := fails || 'EXPLOIT 1 STILL OPEN: minted a live $0 365-day Spotlight';
    exception when others then passes := passes + 1;   -- rejected, as it must be
    end;

    -- ── EXPLOIT 2: funded ad campaign at bid 1 ──────────────────────────────
    begin
      insert into public.ad_campaigns (user_id, kind, status, budget_cents_total, bid_cpm_cents, ends_at)
      values (v_uid, 'ad', 'active', 10000000, 1, now() + interval '365 days');
      fails := fails || 'EXPLOIT 2 STILL OPEN: minted a funded, active ad campaign at bid 1';
    exception when others then passes := passes + 1;
    end;

    -- ── EXPLOIT 3: reset your own spend meter ───────────────────────────────
    -- Needs a row to attack. Create one the legitimate way (unfunded + pending,
    -- which the guard permits), then try to fund it by hand.
    begin
      insert into public.ad_campaigns (user_id, kind, status, ends_at)
      values (v_uid, 'ad', 'pending', now() + interval '7 days');

      update public.ad_campaigns
         set spent_millicents = 0, spent_cents = 0, budget_cents_total = 999999
       where user_id = v_uid and status = 'pending';
      fails := fails || 'EXPLOIT 3 STILL OPEN: reset spend and set budget by hand';
    exception when others then passes := passes + 1;
    end;
  end if;

  -- ── ad_payments is server-write-only ──────────────────────────────────────
  select count(*) into n from pg_policies
   where schemaname='public' and tablename='ad_payments' and permissive = 'RESTRICTIVE';
  if n < 2 then fails := fails || format('ad_payments restrictive policies: %s/2 — receipts are still self-issued', n);
  else passes := passes + 1; end if;

  -- ── A promoted post no longer destroys its paid campaign ──────────────────
  if exists (
    select 1 from pg_constraint c
     where c.conname = 'ad_campaigns_post_id_fkey' and c.confdeltype = 'c'   -- 'c' = CASCADE
  ) then fails := fails || 'post_id FK is still ON DELETE CASCADE — deleting a post destroys the paid campaign';
  else passes := passes + 1; end if;

  -- ── Report ────────────────────────────────────────────────────────────────
  if array_length(fails, 1) is null then
    raise exception E'\n\n  ALL % CHECKS PASSED.\n\n  Prices are server-side, the three exploits are closed, and nothing\n  written by this check survives.\n', passes;
  else
    raise exception E'\n\n  % passed, % FAILED:\n\n  - %\n', passes, array_length(fails, 1), array_to_string(fails, E'\n  - ');
  end if;
end $$;
