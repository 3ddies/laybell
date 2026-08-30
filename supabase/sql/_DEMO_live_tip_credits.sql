-- DEMO CREDITS — $100.00 to @laybell so it can send an $80 tip on camera for
-- the "Go live. Get tipped in real time." screenshot.
--
--   npx supabase db query --linked -f supabase/sql/_DEMO_live_tip_credits.sql
--   npx supabase db query --linked -f supabase/sql/_DEMO_live_tip_CLEANUP.sql   <-- after
--
-- WHY CREDITS AND NOT A FAKED ALERT. The tip alert rides the live broadcast
-- channel, so it only appears if a real tip is really sent. tip_with_credits()
-- spends from the donor's credits balance and ledger_post() refuses to settle a
-- user account negative — so @laybell cannot tip a cent it does not hold. This
-- grant is the same posting that buying credits produces, which is what makes
-- the rest of the flow the genuine one: a real donation row, a real ledger
-- transaction, a real alert.
--
-- $100 for an $80 tip so there is headroom for a retake without re-running this.
-- The bounds are enforced server-side at $6-$500, so $80 is comfortably inside.
--
-- ⚠️ Everything this enables is REAL money movement in the ledger. The cleanup
-- file reverses the tip AND removes whatever credits are left. Run it once the
-- shot is captured.

select public.ledger_post(
  'funding',
  jsonb_build_array(
    jsonb_build_object('user', (select id from public.profiles where lower(username) = 'laybell'),
                       'kind', 'credits', 'amount_cents', 10000),
    jsonb_build_object('user', null, 'kind', 'platform', 'amount_cents', -10000)),
  'manual',
  'demo:live-tip-credits',
  'DEMO credits for the live-tip screenshot - reverse after'
) as transaction_id;

-- ─── Verify ─────────────────────────────────────────────────────────────────
select
  (select coalesce(sum(e.amount_cents), 0)
     from ledger_accounts a join ledger_entries e on e.account_id = a.id
     join public.profiles p on p.id = a.user_id
    where lower(p.username) = 'laybell' and a.kind = 'credits')  as laybell_credits_want_10000,
  (select count(*) from public.ledger_verify())                  as invariant_violations_want_0,
  (select coalesce(sum(amount_cents), 0) from public.ledger_entries) as global_sum_want_0;
