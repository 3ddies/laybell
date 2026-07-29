-- ════════════════════════════════════════════════════════════════════════════
-- LAYBELL LEDGER — the single source of truth for money on the platform.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
--
-- WHY THIS EXISTS
-- Laybell has five money surfaces (Premium, tips, the beat shop, Spotlight, the
-- Ad Manager) and will have three processors (Apple IAP, Google Play Billing,
-- Stripe). Wiring five features to three processors directly is fifteen
-- integrations, and Apple's external-purchase commission is actively being
-- re-litigated — so the rails WILL change.
--
-- Instead every feature moves value against this ledger, and each processor is
-- merely a FUNDING SOURCE into it. When Apple's commission lands at whatever
-- number, you change a funding source, not five features.
--
--     Apple IAP ─┐
--     Play Bill. ─┼──▶ [ credits ] ──▶ purchases / tips ──▶ [ earnings ] ──▶ Stripe
--     Stripe web ─┘                                                          payout
--
-- TWO ACCOUNT KINDS, AND THE DISTINCTION IS LOAD-BEARING
--   'credits'  — bought with real money, SPEND-ONLY, never redeemable for cash.
--                Non-cashable is what keeps credits out of stored-value / prepaid
--                access territory and away from state money-transmitter licensing.
--                If a credit can ever become cash in the buyer's hands, that
--                analysis changes completely. Do not add a credits→bank path.
--   'earnings' — what a creator has actually earned and CAN withdraw, via Stripe
--                Connect, after a hold. This is the only cashable balance.
--   'platform' — Laybell's own counterparty account. Fees land here.
--
-- INVARIANTS THIS FILE ENFORCES (not by convention — by constraint):
--   1. Entries are APPEND-ONLY. Update and delete raise an exception, for
--      everyone including the service role. A ledger you can edit is not a ledger.
--   2. Every transaction BALANCES TO ZERO. Money is moved, never created.
--   3. Idempotent posting. A retried Stripe webhook or re-validated Apple receipt
--      cannot double-credit — (source, external_id) is unique.
--   4. Balances are maintained by trigger and never written directly, so
--      account.balance_cents cannot drift from sum(entries).
--   5. No client can write. Every value movement happens server-side.
--
-- Amounts are integer CENTS in bigint. Never floats — binary floating point
-- cannot represent 0.10 and money bugs from it are unfixable after the fact.
-- ════════════════════════════════════════════════════════════════════════════


-- ─── 1) Accounts ────────────────────────────────────────────────────────────
create table if not exists public.ledger_accounts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete restrict,
  kind          text not null check (kind in ('credits', 'earnings', 'platform')),
  currency      text not null default 'USD',
  -- Maintained ONLY by the trigger below. Never write this column directly.
  balance_cents bigint not null default 0,
  created_at    timestamptz not null default now()
);

-- One account per (user, kind, currency). The platform account has a null user,
-- so a partial unique index covers it separately.
create unique index if not exists ledger_accounts_user_kind_idx
  on public.ledger_accounts (user_id, kind, currency) where user_id is not null;
create unique index if not exists ledger_accounts_platform_idx
  on public.ledger_accounts (kind, currency) where user_id is null;

-- on delete restrict above is deliberate: deleting a user with a non-zero balance
-- must fail loudly rather than silently destroying a financial record. Account
-- deletion has to settle the balance first.


-- ─── 2) Transactions ────────────────────────────────────────────────────────
-- A transaction groups the entries that must be atomic and must balance.
create table if not exists public.ledger_transactions (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in (
                'funding',      -- real money entered (IAP / Play / Stripe)
                'purchase',     -- buyer spends credits on a listing
                'tip',          -- viewer tips a host
                'promotion',    -- Spotlight / ad spend
                'subscription', -- Premium
                'refund',
                'chargeback',
                'payout',       -- earnings leave to a bank via Connect
                'adjustment'    -- manual correction; always explain it
              )),
  -- Where the money came from, when it came from outside. 'internal' means value
  -- moved between existing Laybell accounts and no processor was involved.
  source      text not null default 'internal'
              check (source in ('internal', 'apple_iap', 'google_play', 'stripe', 'manual')),
  -- The processor's own id for this event: a Stripe event id, an Apple original
  -- transaction id, a Play purchase token. THIS is what makes posting idempotent.
  external_id text,
  memo        text,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- The idempotency guarantee. A webhook that fires three times posts once.
create unique index if not exists ledger_tx_external_idx
  on public.ledger_transactions (source, external_id) where external_id is not null;
create index if not exists ledger_tx_created_idx on public.ledger_transactions (created_at desc);


-- ─── 3) Entries ─────────────────────────────────────────────────────────────
create table if not exists public.ledger_entries (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.ledger_transactions(id) on delete restrict,
  account_id     uuid not null references public.ledger_accounts(id) on delete restrict,
  -- Signed: positive credits the account, negative debits it.
  amount_cents   bigint not null check (amount_cents <> 0),
  -- When this money becomes withdrawable. A shop sale sits on a hold so a
  -- chargeback lands before the seller has cashed out and vanished — see
  -- docs/LAUNCH_CHECKLIST.md §6.5. Funding and tips are available immediately.
  available_at   timestamptz not null default now(),
  created_at     timestamptz not null default now()
);

create index if not exists ledger_entries_account_idx
  on public.ledger_entries (account_id, created_at desc);
create index if not exists ledger_entries_tx_idx on public.ledger_entries (transaction_id);
-- Drives the available-balance sum.
create index if not exists ledger_entries_available_idx
  on public.ledger_entries (account_id, available_at);


-- ─── 4) Append-only enforcement ─────────────────────────────────────────────
-- Invariant 1. Corrections are posted as NEW compensating transactions, never by
-- editing history. This fires for the service role too — there is deliberately no
-- way to quietly rewrite a balance.
create or replace function public.ledger_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'ledger_entries is append-only (attempted %). Post a compensating transaction instead.', tg_op;
end $$;

drop trigger if exists ledger_entries_no_update on public.ledger_entries;
create trigger ledger_entries_no_update
  before update or delete on public.ledger_entries
  for each row execute function public.ledger_immutable();


-- ─── 5) Balance maintenance ─────────────────────────────────────────────────
-- Invariant 4. Because entries are append-only, a running total maintained here
-- can never drift from sum(entries) — there is no edit path that could desync it.
create or replace function public.ledger_apply_entry()
returns trigger language plpgsql as $$
begin
  update public.ledger_accounts
     set balance_cents = balance_cents + new.amount_cents
   where id = new.account_id;
  return new;
end $$;

drop trigger if exists ledger_entries_apply on public.ledger_entries;
create trigger ledger_entries_apply
  after insert on public.ledger_entries
  for each row execute function public.ledger_apply_entry();


-- ─── 6) Account helper ──────────────────────────────────────────────────────
create or replace function public.ledger_account(p_user uuid, p_kind text, p_currency text default 'USD')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  if p_kind = 'platform' then
    select id into v_id from public.ledger_accounts
      where user_id is null and kind = 'platform' and currency = p_currency;
    if v_id is null then
      insert into public.ledger_accounts (user_id, kind, currency)
        values (null, 'platform', p_currency) returning id into v_id;
    end if;
    return v_id;
  end if;

  if p_user is null then
    raise exception 'a % account needs a user', p_kind;
  end if;
  select id into v_id from public.ledger_accounts
    where user_id = p_user and kind = p_kind and currency = p_currency;
  if v_id is null then
    insert into public.ledger_accounts (user_id, kind, currency)
      values (p_user, p_kind, p_currency) returning id into v_id;
  end if;
  return v_id;
end $$;


-- ─── 7) Posting ─────────────────────────────────────────────────────────────
-- The ONLY way value moves. Takes a jsonb array of legs:
--
--   [{"user": "<uuid>|null", "kind": "credits|earnings|platform",
--     "amount_cents": -500, "available_at": "2026-08-11T00:00:00Z"}, ...]
--
-- Enforces invariants 2, 3 and 5. Returns the transaction id; on a repeated
-- (source, external_id) it returns the EXISTING id and posts nothing, so callers
-- can retry blindly — which is exactly what webhook delivery requires.
create or replace function public.ledger_post(
  p_kind        text,
  p_legs        jsonb,
  p_source      text default 'internal',
  p_external_id text default null,
  p_memo        text default null,
  p_metadata    jsonb default '{}'::jsonb,
  p_currency    text default 'USD'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tx       uuid;
  v_sum      bigint := 0;
  v_leg      jsonb;
  v_account  uuid;
  v_amount   bigint;
  v_akind    text;
  v_touched  uuid[] := '{}';
  v_bad      record;
begin
  if jsonb_typeof(p_legs) <> 'array' or jsonb_array_length(p_legs) < 2 then
    raise exception 'a transaction needs at least two legs';
  end if;

  -- Invariant 3: idempotency. Checked BEFORE any work so a retry is cheap.
  if p_external_id is not null then
    select id into v_tx from public.ledger_transactions
      where source = p_source and external_id = p_external_id;
    if v_tx is not null then
      return v_tx;   -- already posted; do nothing
    end if;
  end if;

  -- Invariant 2: the legs must sum to zero. Money is moved, never created.
  for v_leg in select * from jsonb_array_elements(p_legs) loop
    v_sum := v_sum + (v_leg->>'amount_cents')::bigint;
  end loop;
  if v_sum <> 0 then
    raise exception 'transaction does not balance: legs sum to % cents, expected 0', v_sum;
  end if;

  begin
    insert into public.ledger_transactions (kind, source, external_id, memo, metadata)
      values (p_kind, p_source, p_external_id, p_memo, coalesce(p_metadata, '{}'::jsonb))
      returning id into v_tx;
  exception when unique_violation then
    -- Two concurrent deliveries of the same webhook both passed the check above.
    -- The unique index is the real guarantee; the loser simply returns the id the
    -- winner created. Idempotency must survive races, not just retries.
    select id into v_tx from public.ledger_transactions
      where source = p_source and external_id = p_external_id;
    return v_tx;
  end;

  for v_leg in select * from jsonb_array_elements(p_legs) loop
    v_akind  := v_leg->>'kind';
    v_amount := (v_leg->>'amount_cents')::bigint;
    v_account := public.ledger_account(
      nullif(v_leg->>'user', '')::uuid, v_akind, p_currency);

    insert into public.ledger_entries (transaction_id, account_id, amount_cents, available_at)
      values (
        v_tx, v_account, v_amount,
        coalesce((v_leg->>'available_at')::timestamptz, now())
      );

    if v_akind <> 'platform' then
      v_touched := v_touched || v_account;
    end if;
  end loop;

  -- A user account must never end up negative — that would mean Laybell paid out,
  -- or let someone spend, money they never had. The platform account MAY go
  -- negative: absorbing a chargeback before recovering it from a seller is a real
  -- state, and hiding it would be worse than showing it.
  --
  -- Checked AFTER every leg is posted, not inside the loop: a single transaction
  -- may legitimately debit and then credit the same account, and an intermediate
  -- negative is not an error. Only the settled state matters.
  select a.id, a.balance_cents, a.kind, a.user_id into v_bad
    from public.ledger_accounts a
   where a.id = any(v_touched) and a.balance_cents < 0
   limit 1;
  if found then
    raise exception 'insufficient funds: % account for user % would settle at % cents',
      v_bad.kind, v_bad.user_id, v_bad.balance_cents;
  end if;

  return v_tx;
end $$;

-- Invariant 5: nothing client-side may post. Every caller is an edge function
-- using the service role (which bypasses these grants), or the dashboard.
revoke all on function public.ledger_post(text, jsonb, text, text, text, jsonb, text) from public;
revoke all on function public.ledger_post(text, jsonb, text, text, text, jsonb, text) from authenticated;
revoke all on function public.ledger_account(uuid, text, text) from public;
revoke all on function public.ledger_account(uuid, text, text) from authenticated;


-- ─── 8) Reading a balance ───────────────────────────────────────────────────
-- `total` is everything the account holds; `available` excludes money still on a
-- hold. Available is computed rather than stored because it changes with the
-- clock, not with any write — a stored copy would need a sweeper and could go
-- stale. The partial index above keeps the sum cheap.
create or replace function public.my_ledger_balance(p_currency text default 'USD')
returns table (kind text, total_cents bigint, available_cents bigint)
language sql
stable
security definer
set search_path = public
as $$
  select a.kind,
         a.balance_cents as total_cents,
         coalesce((
           select sum(e.amount_cents) from public.ledger_entries e
            where e.account_id = a.id and e.available_at <= now()
         ), 0) as available_cents
    from public.ledger_accounts a
   where a.user_id = auth.uid() and a.currency = p_currency;
$$;

grant execute on function public.my_ledger_balance(text) to authenticated;


-- ─── 9) RLS ─────────────────────────────────────────────────────────────────
-- Read-only for the owner; no write policy exists for anyone. The service role
-- bypasses RLS, so edge functions still post normally.
alter table public.ledger_accounts     enable row level security;
alter table public.ledger_transactions enable row level security;
alter table public.ledger_entries      enable row level security;

drop policy if exists "Users read their own ledger accounts" on public.ledger_accounts;
create policy "Users read their own ledger accounts"
  on public.ledger_accounts for select using (user_id = auth.uid());

-- NOTE: columns of the policy's own table are FULLY QUALIFIED inside these
-- subqueries. An unqualified `id` or `account_id` is ambiguous once the subquery
-- joins tables that have a column of the same name, and Postgres rejects the
-- whole statement with "column reference ... is ambiguous". Qualifying costs
-- nothing and removes the entire class of error.
drop policy if exists "Users read their own ledger entries" on public.ledger_entries;
create policy "Users read their own ledger entries"
  on public.ledger_entries for select using (
    exists (select 1 from public.ledger_accounts a
             where a.id = public.ledger_entries.account_id and a.user_id = auth.uid())
  );

drop policy if exists "Users read their own transactions" on public.ledger_transactions;
create policy "Users read their own transactions"
  on public.ledger_transactions for select using (
    exists (select 1 from public.ledger_entries e
             join public.ledger_accounts a on a.id = e.account_id
            where e.transaction_id = public.ledger_transactions.id
              and a.user_id = auth.uid())
  );


-- ─── 10) Statement view ─────────────────────────────────────────────────────
-- What the user sees in the wallet: their own movements, newest first.
-- security_invoker: evaluate the underlying tables' RLS as the CALLER, not as the
-- view owner. Without it a Postgres view runs with the owner's privileges, which
-- would mean the view's own auth.uid() filter is the only thing standing between
-- one user and everyone's entries. Defence in depth on a money table.
create or replace view public.my_ledger_statement with (security_invoker = true) as
  select e.id,
         e.created_at,
         e.amount_cents,
         e.available_at,
         a.kind        as account_kind,
         t.kind        as transaction_kind,
         t.source,
         t.memo,
         t.metadata
    from public.ledger_entries e
    join public.ledger_accounts a on a.id = e.account_id
    join public.ledger_transactions t on t.id = e.transaction_id
   where a.user_id = auth.uid()
   order by e.created_at desc;

grant select on public.my_ledger_statement to authenticated;


-- ─── 11) Reconciliation ─────────────────────────────────────────────────────
-- Invariant 4 should make drift impossible. Verify it anyway — a ledger nobody
-- audits is a ledger nobody can trust. Run from the dashboard periodically; it
-- returns rows ONLY when something is wrong.
create or replace function public.ledger_verify()
returns table (account_id uuid, stored_cents bigint, computed_cents bigint)
language sql
stable
security definer
set search_path = public
as $$
  select a.id, a.balance_cents,
         coalesce((select sum(e.amount_cents) from public.ledger_entries e
                    where e.account_id = a.id), 0)
    from public.ledger_accounts a
   where a.balance_cents <> coalesce(
           (select sum(e.amount_cents) from public.ledger_entries e
             where e.account_id = a.id), 0);
$$;

-- Postgres grants EXECUTE on a new function to PUBLIC by default. Left as-is this
-- SECURITY DEFINER function would let any signed-in user enumerate every account
-- id and balance on the platform. Owner/dashboard only.
revoke all on function public.ledger_verify() from public;
revoke all on function public.ledger_verify() from authenticated;

-- Global solvency: every transaction balanced, so the sum of ALL entries must be
-- exactly zero. A non-zero result means money was created or destroyed.
--   select coalesce(sum(amount_cents), 0) from public.ledger_entries;  -- expect 0
--   select * from public.ledger_verify();                              -- expect 0 rows


-- ─── Worked examples (for the edge functions to follow) ─────────────────────
--
-- Buyer funds $10 of credits through Apple IAP. Real money entered, so the
-- platform account is the counterparty:
--   select public.ledger_post('funding',
--     jsonb_build_array(
--       jsonb_build_object('user', '<buyer>', 'kind', 'credits',  'amount_cents',  1000),
--       jsonb_build_object('user', null,      'kind', 'platform', 'amount_cents', -1000)),
--     'apple_iap', '<original_transaction_id>', 'Credits top-up');
--
-- Buyer spends $10 on a beat; Laybell keeps 15%; the seller's $8.50 is held 14
-- days so a chargeback lands before they can cash out:
--   select public.ledger_post('purchase',
--     jsonb_build_array(
--       jsonb_build_object('user', '<buyer>',  'kind', 'credits',  'amount_cents', -1000),
--       jsonb_build_object('user', '<seller>', 'kind', 'earnings', 'amount_cents',   850,
--                          'available_at', (now() + interval '14 days')),
--       jsonb_build_object('user', null,       'kind', 'platform', 'amount_cents',   150)),
--     'internal', 'order:<order uuid>', 'Beat sale');
--
-- A $6 tip to a standard-tier host (35% fee):
--   select public.ledger_post('tip',
--     jsonb_build_array(
--       jsonb_build_object('user', '<viewer>', 'kind', 'credits',  'amount_cents', -600),
--       jsonb_build_object('user', '<host>',   'kind', 'earnings', 'amount_cents',  390),
--       jsonb_build_object('user', null,       'kind', 'platform', 'amount_cents',  210)),
--     'internal', 'tip:<donation uuid>', 'Live tip');
--
-- Payout of $8.50 to the seller's bank via Stripe Connect:
--   select public.ledger_post('payout',
--     jsonb_build_array(
--       jsonb_build_object('user', '<seller>', 'kind', 'earnings', 'amount_cents', -850),
--       jsonb_build_object('user', null,       'kind', 'platform', 'amount_cents',  850)),
--     'stripe', '<stripe payout id>', 'Bank transfer');
--
-- Rollback:
--   drop view if exists public.my_ledger_statement;
--   drop function if exists public.ledger_verify, public.my_ledger_balance(text),
--                            public.ledger_post(text, jsonb, text, text, text, jsonb, text),
--                            public.ledger_account(uuid, text, text), public.ledger_apply_entry,
--                            public.ledger_immutable;
--   drop table if exists public.ledger_entries, public.ledger_transactions, public.ledger_accounts;
