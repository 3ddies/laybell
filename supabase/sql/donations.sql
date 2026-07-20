-- Laybell Live donations — viewers tip a live host; PREMIUM hosts get paid.
-- Run in the Supabase Dashboard → SQL Editor (after premium.sql + live_features.sql).
--
-- Modeled on shop_orders (see shop.sql): Laybell takes a 15% platform fee, and an
-- estimated tax is added ON TOP (the donor's cost, Poshmark-style) so it never
-- reduces the host's take-home. The money split + the PREMIUM LOCK are computed
-- and enforced SERVER-SIDE by a BEFORE INSERT trigger, so the client can neither
-- fake the split nor donate to a non-premium host. Payments are SIMULATED for now
-- (provider='simulated'), matching ads/spotlight — a real processor swaps in later.
--
-- Degrades gracefully: until this file is applied, lib/donations calls just fail
-- and the Donate button reports "not available", never crashing the live viewer.

do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'live_streams') then
    raise exception 'Run live_features.sql before donations.sql (public.live_streams is missing).';
  end if;
  if not exists (select 1 from information_schema.routines
                 where routine_schema = 'public' and routine_name = 'is_premium') then
    raise exception 'Run premium.sql before donations.sql (public.is_premium is missing).';
  end if;
end $$;

create table if not exists public.donations (
  id                    uuid primary key default gen_random_uuid(),
  donor_id              uuid not null references auth.users(id) on delete cascade,
  streamer_id           uuid not null references auth.users(id) on delete cascade,
  stream_id             uuid not null references public.live_streams(id) on delete cascade,
  amount_cents          integer not null check (amount_cents > 0),   -- the tip itself
  currency              text not null default 'usd',
  laybell_fee_cents     integer not null default 0,                  -- Laybell's 15% cut of the tip
  tax_cents             integer not null default 0,                  -- estimated tax, added on top (donor pays)
  streamer_payout_cents integer not null default 0,                  -- amount_cents - laybell_fee_cents
  provider              text not null default 'simulated',           -- 'simulated' until a real processor
  provider_ref          text,
  status                text not null default 'succeeded' check (status in ('succeeded', 'refunded', 'failed', 'pending')),
  created_at            timestamptz not null default now(),
  processed_at          timestamptz
);

create index if not exists donations_streamer_idx on public.donations (streamer_id, created_at desc);
create index if not exists donations_stream_idx   on public.donations (stream_id, created_at desc);
create index if not exists donations_donor_idx     on public.donations (donor_id, created_at desc);

alter table public.donations enable row level security;

-- SELECT: only the donor and the host can see a donation.
drop policy if exists "Parties can view donations" on public.donations;
create policy "Parties can view donations" on public.donations for select
  using (auth.uid() = donor_id or auth.uid() = streamer_id);

-- INSERT: a signed-in donor records their own donation of a positive amount. The
-- trigger below fills/overrides streamer_id, the money split, provider and status,
-- and REJECTS the insert if the host isn't Premium — so this check stays minimal.
drop policy if exists "Donors can donate" on public.donations;
create policy "Donors can donate" on public.donations for insert
  with check (auth.uid() = donor_id and amount_cents > 0);

-- No client UPDATE/DELETE — donations are immutable from the app (refunds happen
-- server-side via the service role when a real processor lands).

-- Server-side guard: resolve the host from the stream (can't be spoofed), enforce
-- the PREMIUM LOCK, block self-donations, and stamp the 15% fee + estimated tax +
-- payout. Rates mirror lib/donations (DONATION_FEE_RATE 0.15, DONATION_TAX_RATE 0.06).
create or replace function public.donation_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_host uuid;
begin
  select user_id into v_host from public.live_streams where id = new.stream_id;
  if v_host is null then
    raise exception 'stream_not_found';
  end if;
  -- The host is the stream owner, whatever the client sent.
  new.streamer_id := v_host;

  if new.donor_id = v_host then
    raise exception 'cannot_donate_to_self';
  end if;

  -- PREMIUM LOCK: only Premium hosts can receive donations.
  if not public.is_premium(v_host) then
    raise exception 'streamer_not_premium';
  end if;

  new.laybell_fee_cents     := round(new.amount_cents * 0.15);
  new.tax_cents             := round(new.amount_cents * 0.06);
  new.streamer_payout_cents := new.amount_cents - new.laybell_fee_cents;
  new.provider              := coalesce(new.provider, 'simulated');
  new.status                := coalesce(new.status, 'succeeded');
  new.processed_at          := now();
  return new;
end; $$;

drop trigger if exists donations_guard on public.donations;
create trigger donations_guard
  before insert on public.donations
  for each row execute function public.donation_guard();

-- Host earnings rollup (take-home total + count of succeeded donations) for the
-- CALLER only — keyed on auth.uid() so no one can snoop another host's earnings.
create or replace function public.donation_earnings()
returns table (total_cents bigint, donation_count bigint) language sql stable security definer set search_path = public as $$
  select coalesce(sum(streamer_payout_cents), 0)::bigint, count(*)::bigint
  from public.donations
  where streamer_id = auth.uid() and status = 'succeeded';
$$;
grant execute on function public.donation_earnings() to authenticated;

-- ── v2 (2026-07-19): donor message + tiered "Earn More" fee ───────────────────
-- Supersedes the guard above (re-run this whole file to apply). Two changes:
--   1. `message` column — the donor's note; rides the live broadcast channel for
--      the real-time alert, recorded here and clamped to 200 chars.
--   2. NO MORE PREMIUM LOCK. Every host can now receive tips; the Premium perk is
--      "Earn More" — Laybell takes 8% from Premium hosts vs 35% from everyone
--      else (tax still added on top, donor-paid). Rates mirror lib/donations.
alter table public.donations add column if not exists message text;

create or replace function public.donation_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_host uuid;
begin
  select user_id into v_host from public.live_streams where id = new.stream_id;
  if v_host is null then
    raise exception 'stream_not_found';
  end if;
  new.streamer_id := v_host;

  if new.donor_id = v_host then
    raise exception 'cannot_donate_to_self';
  end if;

  -- Tiered platform fee — the Premium "Earn More" perk (8% Premium, 35% standard).
  new.laybell_fee_cents     := round(new.amount_cents * (case when public.is_premium(v_host) then 0.08 else 0.35 end));
  new.tax_cents             := round(new.amount_cents * 0.06);
  new.streamer_payout_cents := new.amount_cents - new.laybell_fee_cents;
  new.provider              := coalesce(new.provider, 'simulated');
  new.status                := coalesce(new.status, 'succeeded');
  new.processed_at          := now();
  new.message               := nullif(left(trim(coalesce(new.message, '')), 200), '');
  return new;
end; $$;
