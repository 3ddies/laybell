-- Undo the live-tip demo: the tip itself, and any credits left over.
-- Run once the "Go live. Get tipped in real time." shot is captured.
--
--   npx supabase db query --linked -f supabase/sql/_DEMO_live_tip_CLEANUP.sql
--
-- Written to work no matter how many takes it took: it reverses EVERY tip from
-- @laybell to @3ddie, and then zeroes whatever credits remain, rather than
-- assuming one tip of one amount.
--
-- The ledger is append-only, so tips are undone by a mirror transaction and the
-- donation rows are deleted separately. The mirror is built from the real
-- amounts, so it balances whatever actually happened.

-- ⚠️ TWO DONOR ACCOUNTS, NOT ONE. The grant files name @laybell, but the tip was
-- actually sent from @laybellreview — that is the account with a known password,
-- so it is the one that gets logged into on the second phone. The $500 top-up
-- followed the phone, not the file. This cleanup zeroed @laybell, reported
-- laybell_credits_want_0 = 0, and left $500 of never-purchased credits sitting on
-- @laybellreview, where nothing was looking.
--
-- That is not a stale balance, it is a mint: tip_with_credits() turns credits
-- into a host's EARNINGS, which are withdrawable once the hold passes. So the
-- loop below covers both demo accounts, and the verify at the bottom checks the
-- WHOLE ledger rather than one username — a check that names the account it
-- expects to be wrong cannot find the account nobody thought of.
do $$
declare
  v_eddie   uuid;
  v_laybell uuid;
  v_name    text;
  v_payout  bigint;
  v_fee     bigint;
  v_spent   bigint;
  v_left    bigint;
begin
  select id into v_eddie from public.profiles where lower(username) = '3ddie';

foreach v_name in array array['laybell', 'laybellreview'] loop
  select id into v_laybell from public.profiles where lower(username) = v_name;
  continue when v_laybell is null;

  select coalesce(sum(streamer_payout_cents), 0),
         coalesce(sum(laybell_fee_cents), 0),
         coalesce(sum(amount_cents), 0)
    into v_payout, v_fee, v_spent
    from public.donations
   where donor_id = v_laybell and streamer_id = v_eddie;

  -- Mirror the tips: take the earnings back off the host, the fee off the
  -- platform, and return the credits to the donor so the debit is undone too.
  --
  -- available_at matches the HOLD, and must. A tip credits earnings at
  -- now() + payout_hold_days, so it is not available yet; dating the reversal in
  -- the PAST — which this file did at first — would have subtracted from the
  -- available subset while the original sat outside it, and shown the host a
  -- NEGATIVE available balance for fourteen days. The totals net to zero either
  -- way, which is exactly why the invariant check would not have caught it.
  if v_spent > 0 then
    perform public.ledger_post(
      'adjustment',
      jsonb_build_array(
        jsonb_build_object('user', v_eddie,   'kind', 'earnings', 'amount_cents', -v_payout,
                           'available_at', now() + (public.payout_hold_days() || ' days')::interval),
        jsonb_build_object('user', v_laybell, 'kind', 'credits',  'amount_cents',  v_spent),
        jsonb_build_object('user', null,      'kind', 'platform', 'amount_cents', -v_fee)),
      'manual', 'demo:live-tip:reversal:' || v_name,
      'Reverses the live-tip screenshot demo');
  end if;

  delete from public.donations where donor_id = v_laybell and streamer_id = v_eddie;

  -- Whatever credits are left (the grant, plus anything just returned) goes back
  -- to the platform, so the demo leaves no balance behind.
  select coalesce(sum(e.amount_cents), 0) into v_left
    from ledger_accounts a join ledger_entries e on e.account_id = a.id
   where a.user_id = v_laybell and a.kind = 'credits';

  if v_left <> 0 then
    perform public.ledger_post(
      'adjustment',
      jsonb_build_array(
        jsonb_build_object('user', v_laybell, 'kind', 'credits',  'amount_cents', -v_left),
        jsonb_build_object('user', null,      'kind', 'platform', 'amount_cents',  v_left)),
      'manual', 'demo:live-tip-credits:reversal:' || v_name,
      'Returns the demo credits');
  end if;
end loop;
end $$;

-- Ended demo broadcasts, if any were left behind by a take.
delete from public.live_streams
 where status = 'ended'
   and user_id = (select id from public.profiles where lower(username) = '3ddie')
   and created_at > now() - interval '1 day';

-- ─── Verify: nothing left anywhere ──────────────────────────────────────────
select
  -- EVERY account holding credits, not @laybell's. Nobody has bought credits in
  -- production yet, so any non-zero balance here is demo money by definition.
  -- Once real purchases exist this becomes a list to eyeball rather than a 0.
  (select coalesce(sum(e.amount_cents), 0)
     from ledger_accounts a join ledger_entries e on e.account_id = a.id
    where a.kind = 'credits')                                        as all_credits_want_0,
  (select coalesce(string_agg(p.username, ', '), '(none)') from (
     select a.user_id, sum(e.amount_cents) as c
       from ledger_accounts a join ledger_entries e on e.account_id = a.id
      where a.kind = 'credits' group by 1 having sum(e.amount_cents) <> 0) x
     join public.profiles p on p.id = x.user_id)                     as who_still_holds_credits,
  -- TOTAL, not the available subset: the tip and its reversal both sit behind
  -- the hold, so they cancel in the total immediately and mature together.
  (select coalesce(sum(e.amount_cents), 0)
     from ledger_accounts a join ledger_entries e on e.account_id = a.id
     join public.profiles p on p.id = a.user_id
    where lower(p.username) = '3ddie' and a.kind = 'earnings')       as eddie_earnings_want_0,
  (select coalesce(sum(e.amount_cents), 0)
     from ledger_accounts a join ledger_entries e on e.account_id = a.id
     join public.profiles p on p.id = a.user_id
    where lower(p.username) = '3ddie' and a.kind = 'earnings'
      and e.available_at <= now())                                   as eddie_available_want_0,
  (select count(*) from public.donations)                            as donations_want_0,
  (select count(*) from public.live_streams)                         as live_streams_want_0,
  (select count(*) from public.ledger_verify())                      as invariant_violations_want_0,
  (select coalesce(sum(amount_cents), 0) from public.ledger_entries) as global_sum_want_0;
