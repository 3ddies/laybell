-- FRESH-START RESET — RUN 2026-08-21. IRREVERSIBLE.
--
--   npx supabase db query --linked -f supabase/sql/_FRESH_START_RESET_2026-08-21.sql
--
-- Written at the moment of running, against the schema as it then stood, exactly as
-- docs/FRESH_START_RESET.md instructs — a script written earlier would have missed
-- whatever tables landed in between.
--
-- PRE-FLIGHT, all confirmed before this ran:
--   • No store review in flight (Apple approved 08-21; Play is an unsent draft).
--   • 21 Cloudflare Stream UIDs captured to Downloads\stream_uids_to_purge.txt.
--     Hazard 2: the DB only stores the HLS manifest URL, so once the rows go the
--     UIDs are unrecoverable and the videos bill monthly as orphans.
--   • Survivor pinned by id, not just by name.
--
-- WHY auth.users AND NOT A TABLE-BY-TABLE WIPE: deleting the root cascades across
-- every dependent table, so nothing can be missed as migrations accumulate. That
-- only became possible today — three separate blockers (follow_events, access_log,
-- ledger RESTRICT) had to be fixed first, each hidden behind the last.

-- ── 0. Clear test purchase history FIRST ────────────────────────────────────
-- `shop_listing_takedown_guard` refuses to delete any listing that ever had a
-- delivered or refunded order, so purchase history can never be cascaded away.
-- Correct in production; it also means the account-delete cascade dies on any
-- seller who ever sold anything — see the deletion-blockers entry in §0.0, where
-- this is recorded as blocker #4 and still needs a decision for real users.
--
-- For a full wipe the protection is moot: every buyer and every seller here is
-- test data and is going anyway. Clearing the orders removes the guard's trigger
-- condition without weakening the guard itself.
delete from public.shop_orders;

-- ── 1. Delete every account except the store-review one ─────────────────────
do $$
declare
  v_survivor uuid;
  v_deleted  int;
begin
  select p.id into v_survivor
    from public.profiles p
   where lower(coalesce(p.username, '')) = 'laybellreview';

  -- Two independent guards. If the demo account were missing or renamed, an
  -- unguarded `delete ... where id <> v_survivor` with a null v_survivor would
  -- delete EVERY account including the one Apple signs in with.
  if v_survivor is null then
    raise exception 'ABORT: laybellreview not found — refusing to delete anything';
  end if;
  if v_survivor <> '8a88a85f-e01c-426d-9611-4e286f7eb6e5'::uuid then
    raise exception 'ABORT: survivor id is %, expected 8a88a85f-… — refusing', v_survivor;
  end if;

  delete from auth.users where id <> v_survivor;
  get diagnostics v_deleted = row_count;
  raise notice 'deleted % accounts, kept laybellreview', v_deleted;
end $$;

-- ── 2. Clear the ledger ─────────────────────────────────────────────────────
-- TRUNCATE, not DELETE: ledger_entries' append-only trigger raises on DELETE by
-- design, and TRUNCATE does not fire row-level triggers. All three tables go in one
-- statement because ledger_entries FKs to the other two. Verified beforehand that
-- NOTHING outside the ledger references these tables, so there is no cascade reach.
--
-- Clearing rather than keeping is deliberate: step 1 leaves the deleted users'
-- balances as anonymised orphans, and the platform account was sitting at
-- -147,186 cents of pure test artefact. A launch ledger should start empty.
truncate table public.ledger_entries, public.ledger_transactions, public.ledger_accounts;

-- ── 3. Re-seed happens NEXT, from seed_review_account.sql ───────────────────
-- Not inlined, so the canonical seed stays the single source of truth. It grants
-- 50,000 cents and 10 years of Premium, and is idempotent on a fixed external_id —
-- which is precisely why the truncate above is required. Without it the re-run
-- posts nothing and laybellreview stays at 48,202 cents instead of 50,000.

-- ── Verify ──────────────────────────────────────────────────────────────────
select
  (select count(*) from auth.users)                     as users_must_be_1,
  (select count(*) from public.profiles)                as profiles_must_be_1,
  (select count(*) from public.posts)                   as posts_must_be_2,
  (select count(*) from public.ledger_entries)          as ledger_entries_must_be_0,
  (select count(*) from public.ledger_accounts)         as ledger_accounts_must_be_0,
  (select count(*) from public.ledger_verify())         as invariant_violations_must_be_0;
