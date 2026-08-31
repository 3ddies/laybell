-- Another $500.00 of demo credits for @laybell, so the live-tip shot can be
-- retaken without re-running the grant each time.
--
--   npx supabase db query --linked -f supabase/sql/_DEMO_live_tip_TOPUP.sql
--
-- Same posting as buying credits. Stacks on the original $100, for $600 total —
-- enough for seven $80 takes, or one at the $500 server ceiling.
--
-- ⚠️ _DEMO_live_tip_CLEANUP.sql already returns WHATEVER credits remain rather
-- than a fixed figure, so it covers this top-up with no change. Run it once the
-- shot is captured; nothing may be live when a build is submitted.
--
-- A DIFFERENT external_id from the original grant on purpose — sharing one would
-- make this a no-op, since ledger_post treats a repeated key as already posted.

select public.ledger_post(
  'funding',
  jsonb_build_array(
    jsonb_build_object('user', (select id from public.profiles where lower(username) = 'laybell'),
                       'kind', 'credits', 'amount_cents', 50000),
    jsonb_build_object('user', null, 'kind', 'platform', 'amount_cents', -50000)),
  'manual',
  'demo:live-tip-credits:topup-1',
  'DEMO credits top-up for live-tip retakes - reverse after'
) as transaction_id;

-- ─── Verify ─────────────────────────────────────────────────────────────────
select
  (select coalesce(sum(e.amount_cents), 0)
     from ledger_accounts a join ledger_entries e on e.account_id = a.id
     join public.profiles p on p.id = a.user_id
    where lower(p.username) = 'laybell' and a.kind = 'credits')  as laybell_credits_want_60000,
  (select count(*) from public.ledger_verify())                  as invariant_violations_want_0,
  (select coalesce(sum(amount_cents), 0) from public.ledger_entries) as global_sum_want_0;
