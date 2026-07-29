-- ════════════════════════════════════════════════════════════════════════════
-- SPENDING CREDITS — tips paid from the ledger.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
-- Requires ledger.sql, donations.sql, and (for studio tips) studio_live.sql.
--
-- This is the other half of the money loop. ledger.sql defined how value is held;
-- this defines how it moves when a user actually spends it.
--
-- WHY AN RPC AND NOT CLIENT CODE
-- The client may not be trusted with any of it. Not the amount (it would send
-- whatever it liked), not the fee rate (it would send 0%), and not the decision
-- that the balance is sufficient. Every number is computed server-side from the
-- database's own state, and the ledger's own constraints refuse the write if the
-- payer can't cover it.
--
-- The old path — a bare client INSERT into donations — is what made tips
-- "conjurable": two accounts could mint a withdrawable balance at will. This
-- replaces it for BOTH livestream and studio tips.
-- ════════════════════════════════════════════════════════════════════════════

-- Laybell's cut, mirroring lib/donations.ts. Premium hosts keep more; that lower
-- rate IS the "Earn More" perk. This is the authority — the client displays a
-- rate, the server applies one, and only this one is real.
--
-- THE RATE IS DICTATED BY THE STORE'S CUT. Tips are paid in credits, and credits
-- are bought through Apple and Google, who take their commission before Laybell
-- sees anything:
--
--                       Apple 30% (standard)   Apple 15% (Small Business)
--   $10 tip
--   Laybell receives           $7.00                   $8.50
--   Creator owed (70%)         $7.00                   $7.00
--   Laybell nets               $0.00                   $1.50
--
-- 30% is BREAK-EVEN while Apple takes 30%, which is the rate Laybell pays until
-- Small Business Program enrolment is approved. The original 8% (creator keeps
-- 92%) lost $2.20 per tip at that commission, and $0.70 even at 15%.
--
-- ⚠️ REVISIT THE DAY SMALL BUSINESS APPROVAL LANDS. At Apple 15% this nets 15%,
-- and dropping back toward 0.20 (creator keeps 80%) restores "Earn More" as a
-- reason to subscribe — at 70% against the standard 65% it barely is, and the
-- $9.99/month subscription is where Premium actually earns anyway. For
-- reference: YouTube Super Thanks pays 70%, Twitch's standard split is 50%.
create or replace function public.tip_fee_rate(p_host uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select case
    when coalesce((select premium_until from public.profiles where id = p_host), 'epoch'::timestamptz) > now()
    then 0.30 else 0.35
  end;
$$;


-- ─── donation_guard v4 ──────────────────────────────────────────────────────
-- The guard trigger fires on EVERY insert into `donations` — including the one
-- tip_post_internal performs — and v3 recomputed the fee and the tax over
-- whatever it was handed. That made the donations row disagree with the ledger
-- entry created microseconds later from the same tip: the ledger moved 20%, the
-- row recorded 8%, and the row recorded a 6% tax that no ledger entry ever moved.
--
-- v4 stops deriving the fee independently and asks tip_fee_rate() instead, so
-- there is one definition of the rate. Tax is zero: tips are paid in credits,
-- and Apple and Google already collected sales tax when the credits were bought.
--
-- Everything else v3 did — resolving the host from a live stream OR a studio
-- session, rejecting self-tips, clamping the message — is preserved, because the
-- legacy insert path still relies on it.
create or replace function public.donation_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_host uuid;
begin
  if new.stream_id is not null then
    select ls.user_id into v_host from public.live_streams ls where ls.id = new.stream_id;
  elsif new.studio_session_id is not null then
    select ss.host_id into v_host from public.studio_sessions ss where ss.id = new.studio_session_id;
  end if;
  if v_host is null then raise exception 'stream_not_found'; end if;
  new.streamer_id := v_host;

  if new.donor_id = v_host then raise exception 'cannot_donate_to_self'; end if;

  new.laybell_fee_cents     := round(new.amount_cents * public.tip_fee_rate(v_host));
  new.tax_cents             := 0;
  new.streamer_payout_cents := new.amount_cents - new.laybell_fee_cents;
  new.provider              := coalesce(new.provider, 'credits');
  new.status                := coalesce(new.status, 'succeeded');
  new.processed_at          := now();
  new.message               := nullif(left(trim(coalesce(new.message, '')), 200), '');
  return new;
end; $$;


-- ─── Shared posting core ────────────────────────────────────────────────────
-- Both tip entry points funnel through here. The money logic — bounds, fee,
-- split, ledger legs — exists exactly once, so livestream and studio tips cannot
-- drift apart. Duplicating it was how studio tipping ended up still using the old
-- insecure path after livestreams were fixed.
--
-- Internal: never granted to clients. The public wrappers below resolve the host
-- from their own table and then call this.
create or replace function public.tip_post_internal(
  p_host uuid,
  p_amount_cents int,
  p_message text,
  p_stream_id uuid,
  p_studio_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_donor    uuid := auth.uid();
  v_rate     numeric;
  v_fee      int;
  v_payout   int;
  v_donation uuid;
  v_tx       uuid;
begin
  if v_donor is null then raise exception 'not_signed_in'; end if;
  if p_host is null then raise exception 'host_not_found'; end if;
  if p_host = v_donor then raise exception 'cannot_tip_self'; end if;

  -- Bounds enforced here, not in the app. $6 is the processing-economics floor
  -- (see lib/donations.ts); without a server check a crafted request could post a
  -- $0.01 tip that costs more to handle than it earns.
  if p_amount_cents < 600 or p_amount_cents > 50000 then
    raise exception 'amount_out_of_range';
  end if;

  v_rate   := public.tip_fee_rate(p_host);
  v_fee    := round(p_amount_cents * v_rate);
  v_payout := p_amount_cents - v_fee;

  -- The donation row first, so its id can key the ledger transaction — the two
  -- records point at each other and the posting gets an idempotency key.
  -- donations requires EXACTLY ONE of stream_id / studio_session_id; the wrappers
  -- pass one and null for the other.
  insert into public.donations (
    donor_id, streamer_id, stream_id, studio_session_id, amount_cents,
    laybell_fee_cents, tax_cents, streamer_payout_cents,
    provider, status, processed_at
  ) values (
    v_donor, p_host, p_stream_id, p_studio_session_id, p_amount_cents,
    v_fee, 0, v_payout,
    'credits', 'succeeded', now()
  ) returning id into v_donation;

  -- The host's earnings land behind a hold (payouts.sql → payout_hold_days).
  --
  -- An earlier version of this comment said the money was already collected when
  -- the credits were bought, so there was no chargeback window to wait out. That
  -- was wrong. The credits PURCHASE can be refunded by Apple or Google well after
  -- the fact, and `ledger_post` refuses to settle a user account negative — so a
  -- refund of already-spent credits fails and Laybell absorbs the loss with no
  -- way to claw it back. The window is on the purchase, not the tip, but it is
  -- real, and once a creator can actually withdraw it becomes a cash loss rather
  -- than a number on a screen.
  --
  -- The donor's debit and the platform fee are NOT held — only money that can
  -- leave the system needs to wait.
  v_tx := public.ledger_post(
    'tip',
    jsonb_build_array(
      jsonb_build_object('user', v_donor, 'kind', 'credits',  'amount_cents', -p_amount_cents),
      jsonb_build_object('user', p_host,  'kind', 'earnings', 'amount_cents',  v_payout,
                         'available_at', now() + (public.payout_hold_days() || ' days')::interval),
      jsonb_build_object('user', null,    'kind', 'platform', 'amount_cents',  v_fee)
    ),
    'internal',
    'tip:' || v_donation::text,
    coalesce(nullif(p_message, ''), 'Live tip')
  );

  return jsonb_build_object(
    'ok', true,
    'donation_id', v_donation,
    'transaction_id', v_tx,
    'amount_cents', p_amount_cents,
    'fee_cents', v_fee,
    'payout_cents', v_payout
  );
end $$;

revoke all on function public.tip_post_internal(uuid, int, text, uuid, uuid) from public, authenticated;


-- ─── Tip a LIVESTREAM host ──────────────────────────────────────────────────
create or replace function public.tip_with_credits(
  p_stream_id uuid,
  p_amount_cents int,
  p_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_host uuid;
begin
  select user_id into v_host from public.live_streams where id = p_stream_id;
  if v_host is null then raise exception 'stream_not_found'; end if;
  return public.tip_post_internal(v_host, p_amount_cents, p_message, p_stream_id, null);
end $$;

grant execute on function public.tip_with_credits(uuid, int, text) to authenticated;


-- ─── Tip a LIVE STUDIO host ─────────────────────────────────────────────────
-- The gap this closes: studio tips previously took the old client-INSERT path,
-- so they were still conjurable after livestream tips were secured. Same three
-- legs, same fee logic — only the host lookup differs.
create or replace function public.tip_studio_with_credits(
  p_session_id uuid,
  p_amount_cents int,
  p_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_host uuid;
begin
  select host_id into v_host from public.studio_sessions where id = p_session_id;
  if v_host is null then raise exception 'session_not_found'; end if;
  return public.tip_post_internal(v_host, p_amount_cents, p_message, null, p_session_id);
end $$;

grant execute on function public.tip_studio_with_credits(uuid, int, text) to authenticated;

grant execute on function public.tip_fee_rate(uuid) to authenticated;


-- ─── Note: insufficient balance ─────────────────────────────────────────────
-- Not checked explicitly, and that is deliberate. ledger_post refuses to settle a
-- user account below zero and raises 'insufficient funds'. Duplicating the check
-- here would introduce a second source of truth that could drift from the first,
-- and it would still race — the ledger's constraint is inside the transaction,
-- any check here would not be. Let the ledger be the authority and translate its
-- error in the client.


-- ─── Lock the old path shut ─────────────────────────────────────────────────
-- Both tip routes now go through the RPCs above, so a direct client INSERT into
-- donations should no longer be possible. This restrictive policy ANDs with the
-- existing permissive ones: rows may still be created by the SECURITY DEFINER
-- functions (they run as the owner and bypass RLS), but not by a client.
--
-- Without this, closing the studio hole in code would leave the hole open in the
-- database — anyone with the anon key could keep inserting donations directly.
do $$
begin
  if to_regclass('public.donations') is null then return; end if;
  execute $p$
    drop policy if exists "Donations are created server-side only" on public.donations;
  $p$;
  execute $p$
    create policy "Donations are created server-side only"
      on public.donations as restrictive for insert
      with check (false);
  $p$;
end $$;


-- ─── Not built yet: shop purchases ──────────────────────────────────────────
-- Paying for Shop listings with credits is deliberately NOT included, because it
-- is not merely a technical step. Today the Shop is a VENUE: the app tells buyers
-- "Laybell doesn't process payments — you arrange payment with the seller", and
-- Laybell never touches the money.
--
-- Routing Shop payments through credits makes Laybell the one collecting and
-- remitting, which very likely makes it a MARKETPLACE FACILITATOR — sales-tax
-- collection and monthly filing (Maryland taxes digital products at 6%), plus
-- 1099 reporting for sellers.
--
-- That is a business decision with real recurring cost, not a code change.
-- See docs/LAUNCH_CHECKLIST.md §6.6.


-- Verify after running:
--   select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname='public' and proname like 'tip%';
--   -- expect: tip_fee_rate, tip_post_internal, tip_studio_with_credits, tip_with_credits
