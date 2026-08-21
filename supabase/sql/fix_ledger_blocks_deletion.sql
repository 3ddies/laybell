-- Account deletion blocker #3: ledger_accounts ON DELETE RESTRICT.  2026-08-21.
--
--   npx supabase db query --linked -f supabase/sql/fix_ledger_blocks_deletion.sql
--
-- MONEY CODE. Read the whole file before running it — that is this project's rule,
-- and it exists because two adversarial reviews found 11 money bugs, 6 of which
-- could mint money.
--
-- ─── THE PROBLEM ────────────────────────────────────────────────────────────
-- `ledger_accounts.user_id references auth.users(id) ON DELETE RESTRICT`, and 7 of
-- 10 production accounts already have a ledger account. RESTRICT does not mean
-- "financial records are retained" — it means the DELETE is REFUSED outright, so
-- the account, profile, posts and everything else survive too. Deletion silently
-- fails for anyone who has ever transacted, while the app tells them their account
-- is "permanently removed after 48 hours."
--
-- ─── WHY THE OBVIOUS FIXES ARE WRONG ────────────────────────────────────────
-- Flipping the FK to SET NULL on its own is a TRAP. This index exists:
--
--   create unique index ledger_accounts_platform_idx
--     on ledger_accounts (kind, currency) where user_id is null;
--
-- It reserves the null-user namespace for the single platform account. Null a
-- deleted user's `credits` row into it and the FIRST deletion works; the SECOND
-- deleted user with a credits account collides and the delete fails. That bug
-- passes a one-account test and only appears once two people have ever deleted —
-- exactly the shape of failure this codebase keeps getting bitten by.
--
-- Reassigning to a sentinel "deleted user" fails the same way against
-- `ledger_accounts_user_kind_idx` (one account per user+kind+currency), and needs a
-- permanent fake auth.users row that shows up in every user count.
--
-- ─── WHAT THIS DOES ─────────────────────────────────────────────────────────
-- Severs identity, keeps the money. Not one ledger_entries row is touched, so
-- immutability, per-account balances, ledger_verify() and global solvency
-- (sum of all entries = 0) are all untouched by construction. ledger_verify()
-- compares balance_cents against the sum of entries and never reads user_id.
--
-- `former_user_id` is kept deliberately rather than discarding the link entirely.
-- Card disputes run to ~120 days (see access_log.sql's retention note); a user can
-- delete their account and a chargeback can land afterwards. Without it you cannot
-- reconcile that. It is a bare UUID whose `profiles` row is gone with the cascade,
-- so it resolves to no identity inside this database — a pseudonymous key for
-- financial reconciliation, which is precisely what deletion-right carve-outs for
-- financial records contemplate.

-- ── 1. Where the severed identity goes ──────────────────────────────────────
-- No FK: the referenced user is gone by definition, which is the entire point.
alter table public.ledger_accounts
  add column if not exists former_user_id uuid;

comment on column public.ledger_accounts.former_user_id is
  'Set automatically when the owning auth.users row is deleted and the FK nulls user_id. Pseudonymous key for financial reconciliation (chargebacks land up to ~120 days later); resolves to no identity here, as profiles cascades away with the user.';

-- ── 2. Capture the identity as the FK severs it ─────────────────────────────
-- BEFORE UPDATE, so it runs inside the cascade itself. The guard is narrow: it
-- fires ONLY on a non-null -> null transition of user_id. Every other update —
-- notably ledger_apply_entry()'s balance_cents writes, and any write to the
-- platform account, where user_id is null both before and after — falls straight
-- through unchanged.
create or replace function public.ledger_accounts_anonymize()
returns trigger language plpgsql as $$
begin
  if old.user_id is not null and new.user_id is null then
    new.former_user_id := old.user_id;
  end if;
  return new;
end $$;

drop trigger if exists ledger_accounts_anonymize_trg on public.ledger_accounts;
create trigger ledger_accounts_anonymize_trg
  before update on public.ledger_accounts
  for each row execute function public.ledger_accounts_anonymize();

-- ── 3. Stop the platform index from swallowing anonymised rows ──────────────
-- THIS IS THE LOAD-BEARING CHANGE. Without it, the second deletion fails.
-- The guarantee it protects is unchanged: exactly one platform account per
-- (kind, currency). Anonymised rows are excluded because they carry
-- former_user_id, which the true platform account never will — a platform account
-- is created with a null user_id from the start and so has no user to delete.
drop index if exists public.ledger_accounts_platform_idx;
create unique index if not exists ledger_accounts_platform_idx
  on public.ledger_accounts (kind, currency)
  where user_id is null and former_user_id is null;

-- ── 4. Keep the same one-account-per-kind rule for deleted users ────────────
-- Preserves ledger_accounts_user_kind_idx's invariant across the transition, so a
-- deleted user cannot end up with two 'credits' accounts.
create unique index if not exists ledger_accounts_former_kind_idx
  on public.ledger_accounts (former_user_id, kind, currency)
  where former_user_id is not null;

-- ── 5. Flip the FK — LAST, so 2/3/4 are already in force ────────────────────
alter table public.ledger_accounts
  drop constraint ledger_accounts_user_id_fkey;
alter table public.ledger_accounts
  add constraint ledger_accounts_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;

-- ── NOT CHANGED, and why ────────────────────────────────────────────────────
-- ledger_account()'s platform lookup is `where user_id is null and kind =
-- 'platform'`. An anonymised row always has kind 'credits' or 'earnings' — a
-- platform account has no owning user and therefore can never be anonymised — so
-- that lookup cannot match one. Left alone on purpose: every line of money code
-- not edited is a line that cannot be broken.
--
-- ⚠️ OPEN PRODUCT QUESTION, not a schema bug: a user who deletes with a positive
-- earnings balance leaves that money in an unclaimable anonymised account. That is
-- correct accounting — deleting the entries would unbalance the ledger — but the
-- app should probably refuse deletion, or warn, while `available_cents > 0`.
-- Nobody has real earnings pre-launch, so this is a follow-up, not a blocker.
