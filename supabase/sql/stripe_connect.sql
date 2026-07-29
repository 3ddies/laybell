-- Stripe Connect — creator payout accounts.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
--
-- WHY THE COLUMN IS ALL THERE IS
-- Creators are paid through Stripe Connect EXPRESS accounts. Stripe collects the
-- bank details, runs identity verification, and owns the payout rails. Laybell
-- stores one thing: the id of the creator's Stripe account. No bank numbers, no
-- routing numbers, no tax identifiers — all of that lives with Stripe, which is
-- both the point and the reason this migration is three lines.
--
-- The rule that shapes the whole design: creator funds must NEVER pass through a
-- Laybell-controlled bank account. Doing so is unlicensed money transmission
-- (18 U.S.C. §1960). Stripe holds and moves the money; Laybell instructs it.

alter table public.profiles
  -- Stripe's account id (acct_…). Written only by the stripe-connect Edge
  -- Function using the service role. Not secret — it identifies an account but
  -- grants no access to it — though there is no reason for other users to read it.
  add column if not exists stripe_account_id text;

-- Two creators must never share a Stripe account: a collision would pay one
-- person's earnings to another. Partial so the many nulls don't collide.
create unique index if not exists profiles_stripe_account_uniq
  on public.profiles (stripe_account_id) where stripe_account_id is not null;

-- No new RLS policy is needed. profiles already restricts writes to the owner,
-- and the Edge Function bypasses RLS with the service role. Deliberately NOT
-- granting the client write access: a user who could set their own
-- stripe_account_id could point their payouts at someone else's account.


-- Verify:
--   select id, username, stripe_account_id from public.profiles
--    where stripe_account_id is not null;
--
-- Payout readiness is NOT stored here. `payouts_enabled` lives on the Stripe
-- account and is read live via the stripe-connect function, because a cached
-- copy goes stale the moment Stripe finishes (or reverses) a verification — and
-- a stale "yes" means attempting a payout that fails at the transfer.
