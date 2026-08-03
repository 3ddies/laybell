-- ───────────────────────────────────────────────────────────────────────────
-- Seed the STORE REVIEW demo account (Apple + Google Play reviewers).
--
-- Reviewers who can't reach a feature assume it's broken, and an empty account
-- reads as a broken app. This gives the demo account Premium and a credit
-- balance so every gated surface opens without the reviewer spending money.
--
-- SAFE TO RE-RUN. The credit grant is idempotent on a fixed external_id, so a
-- second run posts nothing (ledger_post rejects the duplicate). Premium is an
-- absolute timestamp, not an increment.
--
-- HOW TO RUN: Supabase → SQL editor. Set the username on the next line first.
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  -- ↓↓↓ SET THIS to the demo account's username (no @) ↓↓↓
  v_username  text := 'REPLACE_ME';

  v_user      uuid;
  v_credits   bigint := 50000;   -- $500.00 in credits (1 credit = 1 cent)
  v_tx        uuid;
begin
  select id into v_user from public.profiles
   where lower(username) = lower(v_username);

  if v_user is null then
    raise exception 'No profile with username %. Create and verify the account in the app first.', v_username;
  end if;

  -- ── 1. Premium, far enough out that it can't lapse mid-review ────────────
  update public.profiles
     set premium_until = now() + interval '10 years'
   where id = v_user;
  raise notice 'Premium granted to % until %', v_username, now() + interval '10 years';

  -- ── 2. Credits, posted through the ledger (never a direct balance write) ──
  -- Counterparty is the platform account, exactly like a real funding event.
  -- source='internal' + a fixed external_id makes this idempotent: re-running
  -- raises a duplicate and is swallowed below.
  begin
    select public.ledger_post(
      'funding',
      jsonb_build_array(
        jsonb_build_object('user', v_user, 'kind', 'credits',  'amount_cents',  v_credits),
        jsonb_build_object('user', null,   'kind', 'platform', 'amount_cents', -v_credits)
      ),
      'internal',
      'store_review_seed_' || v_user::text,
      'Store review demo account seed — not a real purchase'
    ) into v_tx;
    raise notice 'Credits granted: % cents (tx %)', v_credits, v_tx;
  exception when others then
    raise notice 'Credit grant skipped (already seeded, or: %)', sqlerrm;
  end;

  raise notice '--- Done. Verify below. ---';
end $$;

-- ── Verification — run this after, and read it before handing over creds ────
select
  p.username,
  p.display_name,
  (p.premium_until > now())                                as premium_active,
  p.premium_until,
  coalesce((
    select sum(e.amount_cents) from public.ledger_entries e
      join public.ledger_accounts a on a.id = e.account_id
     where a.user_id = p.id and a.kind = 'credits'
  ), 0)                                                    as credit_balance_cents,
  (select count(*) from public.posts   where user_id = p.id and archived_at is null) as visible_posts,
  (select count(*) from public.shop_listings where user_id = p.id and status = 'active') as active_listings
from public.profiles p
where lower(p.username) = lower('REPLACE_ME');   -- ← same username here
