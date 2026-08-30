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

do $$
declare
  v_eddie   uuid;
  v_laybell uuid;
  v_payout  bigint;
  v_fee     bigint;
  v_spent   bigint;
  v_left    bigint;
begin
  select id into v_eddie   from public.profiles where lower(username) = '3ddie';
  select id into v_laybell from public.profiles where lower(username) = 'laybell';

  select coalesce(sum(streamer_payout_cents), 0),
         coalesce(sum(laybell_fee_cents), 0),
         coalesce(sum(amount_cents), 0)
    into v_payout, v_fee, v_spent
    from public.donations
   where donor_id = v_laybell and streamer_id = v_eddie;

  -- Mirror the tips: take the earnings back off the host, the fee off the
  -- platform, and return the credits to the donor so the debit is undone too.
  if v_spent > 0 then
    perform public.ledger_post(
      'adjustment',
      jsonb_build_array(
        jsonb_build_object('user', v_eddie,   'kind', 'earnings', 'amount_cents', -v_payout,
                           'available_at', now() - interval '1 day'),
        jsonb_build_object('user', v_laybell, 'kind', 'credits',  'amount_cents',  v_spent),
        jsonb_build_object('user', null,      'kind', 'platform', 'amount_cents', -v_fee)),
      'manual', 'demo:live-tip:reversal', 'Reverses the live-tip screenshot demo');
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
      'manual', 'demo:live-tip-credits:reversal', 'Returns the demo credits');
  end if;
end $$;

-- Ended demo broadcasts, if any were left behind by a take.
delete from public.live_streams
 where status = 'ended'
   and user_id = (select id from public.profiles where lower(username) = '3ddie')
   and created_at > now() - interval '1 day';

-- ─── Verify: nothing left anywhere ──────────────────────────────────────────
select
  (select coalesce(sum(e.amount_cents), 0)
     from ledger_accounts a join ledger_entries e on e.account_id = a.id
     join public.profiles p on p.id = a.user_id
    where lower(p.username) = 'laybell' and a.kind = 'credits')      as laybell_credits_want_0,
  (select coalesce(sum(e.amount_cents), 0)
     from ledger_accounts a join ledger_entries e on e.account_id = a.id
     join public.profiles p on p.id = a.user_id
    where lower(p.username) = '3ddie' and a.kind = 'earnings')       as eddie_earnings_want_0,
  (select count(*) from public.donations)                            as donations_want_0,
  (select count(*) from public.live_streams)                         as live_streams_want_0,
  (select count(*) from public.ledger_verify())                      as invariant_violations_want_0,
  (select coalesce(sum(amount_cents), 0) from public.ledger_entries) as global_sum_want_0;
