-- Spotlight and Ad Manager through credits — and locking the doors that were open.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
-- REQUIRES: ledger.sql, payouts.sql, spotlight.sql, ad_ecosystem.sql, spotlight_credit.sql.
--
-- TWO PROBLEMS, ONE FIX.
--
-- 1. NOTHING WAS EVER CHARGED. Buying a Spotlight ran a 900ms fake delay in the
--    app and then inserted a campaign row plus an `ad_payments` row with
--    provider='simulated'. Ad campaigns funded themselves the same way. The app
--    said so ("Simulated checkout"), which made it honest but not free: feed
--    promotion has real value, and it was being given away.
--
-- 2. THE TABLES WERE WIDE OPEN, and this part is not theoretical. The only
--    INSERT check on ad_campaigns was `auth.uid() = user_id`. Nothing looked at
--    status, price, dates, weight or post ownership. So a crafted insert could
--    mint a LIVE 365-day Spotlight at weight 10 for $0 — and the post-ownership
--    rule existed only on UPDATE, so passing post_id at INSERT skipped it
--    entirely. An ad campaign could be minted with any budget and
--    bid_cpm_cents=1, which is a thousand times the delivery per dollar. Worse,
--    the UPDATE policy's WITH CHECK constrained only post_id, which is null for
--    ads — so an advertiser could reset their own meter:
--        update ad_campaigns set spent_millicents = 0, budget_cents_total = 999999;
--    record_ad_event's careful anti-fraud accrual was undone by one UPDATE.
--
-- Both are the same fix: creation and pricing move to the server, and the client
-- loses the ability to write money columns at all. This mirrors what donations
-- and shop_orders already do.
--
-- APPLE 3.1.3(g) names promotional boosts explicitly as requiring in-app
-- purchase, which is the other reason this could not stay as it was.

-- ─── Server-side prices ─────────────────────────────────────────────────────
-- The package price lived ONLY in lib/spotlight.ts and was sent by the client.
-- The SQL files carried the numbers in a comment. Here they become the
-- authority; the app's copy is now just what it renders before asking.
-- The columns are listed explicitly rather than `select *`: the VALUES list
-- carries the package key as its first column, so `*` returns four columns
-- against a three-column RETURNS TABLE and Postgres rejects the function at
-- creation time with "Final statement returns text instead of integer".
create or replace function public.spotlight_package(p_key text)
returns table (price_cents int, duration_days numeric, weight int)
language sql immutable as $$
  select t.price_cents, t.duration_days, t.weight
    from (values
      ('12h',  599, 0.5::numeric, 1),
      ('1d',  1099, 1.0::numeric, 2),
      ('3d',  2499, 3.0::numeric, 3),
      ('7d',  4999, 7.0::numeric, 4)
    ) as t(k, price_cents, duration_days, weight)
   where t.k = p_key;
$$;

-- Minimum ad budget. There was none — `parseFloat(budget) > 0` was the only
-- check anywhere, so a 1-cent campaign was possible.
create or replace function public.ad_min_budget_cents()
returns int language sql immutable as $$ select 500 $$;

-- $10.00 per 1,000 impressions. Mirrors AD_DEFAULT_CPM_CENTS in lib/ads.ts.
-- The server previously read `coalesce(bid_cpm_cents, 0)` straight off the row,
-- trusting whatever the client inserted.
create or replace function public.ad_default_cpm_cents()
returns int language sql immutable as $$ select 1000 $$;


-- ─── Trusted-context flag ───────────────────────────────────────────────────
-- The guard trigger below has to tell "the server is doing this" from "a client
-- is doing this". SECURITY DEFINER alone isn't a reliable signal, so the trusted
-- functions set a transaction-local flag instead. `true` as the third argument
-- scopes it to the transaction — it cannot leak into the next statement on a
-- pooled connection.
create or replace function public.promo_trusted()
returns boolean language sql stable as $$
  select coalesce(current_setting('laybell.promo_trusted', true), '') = 'on';
$$;


-- ─── Buying a Spotlight ─────────────────────────────────────────────────────
-- Deliberately keeps the existing two-step shape — pay, then choose the post —
-- because that is what the screen does today and reordering it would be a UI
-- rewrite for no safety gain. The campaign is created 'pending' with no post
-- attached; spotlight_activate below attaches one. A pending campaign that never
-- gets used is refundable, which is what makes the two-step honest.
create or replace function public.spotlight_buy_with_credits(p_package_key text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_pkg  record;
  v_camp uuid;
begin
  if v_user is null then raise exception 'not_signed_in'; end if;

  select * into v_pkg from public.spotlight_package(p_package_key);
  if not found then raise exception 'unknown_package'; end if;

  perform set_config('laybell.promo_trusted', 'on', true);

  insert into public.ad_campaigns (
    user_id, kind, package_key, duration_days, price_cents, weight, status
  ) values (
    v_user, 'spotlight', p_package_key, v_pkg.duration_days,
    v_pkg.price_cents, v_pkg.weight, 'pending'
  ) returning id into v_camp;

  -- Credits out, platform in. No creator-earnings leg: this is Laybell selling
  -- its own inventory, not a transfer between two users.
  perform public.ledger_post(
    'promotion',
    jsonb_build_array(
      jsonb_build_object('user', v_user, 'kind', 'credits',  'amount_cents', -v_pkg.price_cents),
      jsonb_build_object('user', null,   'kind', 'platform', 'amount_cents',  v_pkg.price_cents)
    ),
    'internal', 'spotlight:' || v_camp::text, 'Spotlight ' || p_package_key
  );

  insert into public.ad_payments (user_id, campaign_id, amount_cents, provider, status)
  values (v_user, v_camp, v_pkg.price_cents, 'credits', 'succeeded');

  return v_camp;
end $$;

grant execute on function public.spotlight_buy_with_credits(text) to authenticated;


-- Attach a post and go live. Post ownership was previously checked only by the
-- UPDATE policy, which meant passing post_id at INSERT skipped it entirely.
create or replace function public.spotlight_activate(p_campaign_id uuid, p_post_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_camp public.ad_campaigns%rowtype;
begin
  if v_user is null then raise exception 'not_signed_in'; end if;

  select * into v_camp from public.ad_campaigns c
   where c.id = p_campaign_id and c.user_id = v_user for update;
  if not found then raise exception 'campaign_not_found'; end if;
  if v_camp.status <> 'pending' then raise exception 'already_activated'; end if;

  if not exists (
    select 1 from public.posts p
     where p.id = p_post_id and p.user_id = v_user and p.is_public and p.archived_at is null
  ) then
    raise exception 'post_not_promotable';
  end if;

  perform set_config('laybell.promo_trusted', 'on', true);
  update public.ad_campaigns c
     set post_id   = p_post_id,
         status    = 'active',
         starts_at = now(),
         ends_at   = now() + (v_camp.duration_days || ' days')::interval
   where c.id = p_campaign_id;
end $$;

grant execute on function public.spotlight_activate(uuid, uuid) to authenticated;


-- Cancel an unused Spotlight and give the credits back. The old version did this
-- as two separate client UPDATEs — campaign then payment — so a failure between
-- them left a cancelled campaign with a 'succeeded' payment. One transaction now.
create or replace function public.spotlight_cancel_pending(p_campaign_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_camp public.ad_campaigns%rowtype;
begin
  if v_user is null then raise exception 'not_signed_in'; end if;

  select * into v_camp from public.ad_campaigns c
   where c.id = p_campaign_id and c.user_id = v_user for update;
  if not found then raise exception 'campaign_not_found'; end if;
  if v_camp.status <> 'pending' then raise exception 'not_cancellable'; end if;

  perform set_config('laybell.promo_trusted', 'on', true);
  update public.ad_campaigns c set status = 'canceled' where c.id = p_campaign_id;
  update public.ad_payments  a set status = 'refunded' where a.campaign_id = p_campaign_id;

  perform public.ledger_post(
    'refund',
    jsonb_build_array(
      jsonb_build_object('user', null,   'kind', 'platform', 'amount_cents', -v_camp.price_cents),
      jsonb_build_object('user', v_user, 'kind', 'credits',  'amount_cents',  v_camp.price_cents)
    ),
    'internal', 'spotlight-refund:' || p_campaign_id::text, 'Spotlight cancelled'
  );
end $$;

grant execute on function public.spotlight_cancel_pending(uuid) to authenticated;


-- ─── Funding an ad campaign ─────────────────────────────────────────────────
-- The whole budget is taken up front. Metering then spends against it, and
-- whatever is left comes back when the campaign ends (see below) — which is the
-- only honest reading of a prepaid budget.
create or replace function public.ad_campaign_fund_with_credits(
  p_campaign_id uuid,
  p_budget_cents int
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_camp public.ad_campaigns%rowtype;
begin
  if v_user is null then raise exception 'not_signed_in'; end if;
  if p_budget_cents < public.ad_min_budget_cents() then raise exception 'below_minimum'; end if;

  select * into v_camp from public.ad_campaigns c
   where c.id = p_campaign_id and c.user_id = v_user for update;
  if not found then raise exception 'campaign_not_found'; end if;
  if v_camp.status <> 'pending' then raise exception 'already_funded'; end if;

  perform set_config('laybell.promo_trusted', 'on', true);

  update public.ad_campaigns c
     set budget_cents_total = p_budget_cents,
         -- The client used to choose this. A bid of 1 bought a thousand times
         -- the delivery per dollar.
         bid_cpm_cents      = public.ad_default_cpm_cents(),
         spent_cents        = 0,
         spent_millicents   = 0,
         status             = 'active'
   where c.id = p_campaign_id;

  perform public.ledger_post(
    'promotion',
    jsonb_build_array(
      jsonb_build_object('user', v_user, 'kind', 'credits',  'amount_cents', -p_budget_cents),
      jsonb_build_object('user', null,   'kind', 'platform', 'amount_cents',  p_budget_cents)
    ),
    'internal', 'ad:' || p_campaign_id::text, 'Ad campaign budget'
  );

  insert into public.ad_payments (user_id, campaign_id, amount_cents, provider, status)
  values (v_user, p_campaign_id, p_budget_cents, 'credits', 'succeeded');
end $$;

grant execute on function public.ad_campaign_fund_with_credits(uuid, int) to authenticated;


-- ─── Ending a campaign, and returning what wasn't spent ─────────────────────
-- The copy said "Spent budget is not refunded", which implies the UNSPENT part
-- is. It wasn't — `endAdCampaign` wrote only `status` and the remainder was
-- abandoned. Harmless while the budget was imaginary; with real credits that
-- sentence would have been a false statement about money. So it is now true.
--
-- Spotlight is different and stays different: it is a flat package price for a
-- time window, with no per-impression meter to prorate against, so ending early
-- refunds nothing. The copy says so.
create or replace function public.ad_campaign_end(p_campaign_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user   uuid := auth.uid();
  v_camp   public.ad_campaigns%rowtype;
  v_unspent bigint;
begin
  if v_user is null then raise exception 'not_signed_in'; end if;

  select * into v_camp from public.ad_campaigns c
   where c.id = p_campaign_id and c.user_id = v_user for update;
  if not found then raise exception 'campaign_not_found'; end if;
  if v_camp.status not in ('active', 'paused') then return 0; end if;

  v_unspent := greatest(0, coalesce(v_camp.budget_cents_total, 0) - coalesce(v_camp.spent_cents, 0));

  perform set_config('laybell.promo_trusted', 'on', true);
  update public.ad_campaigns c set status = 'ended' where c.id = p_campaign_id;

  if v_unspent > 0 then
    perform public.ledger_post(
      'refund',
      jsonb_build_array(
        jsonb_build_object('user', null,   'kind', 'platform', 'amount_cents', -v_unspent),
        jsonb_build_object('user', v_user, 'kind', 'credits',  'amount_cents',  v_unspent)
      ),
      'internal', 'ad-refund:' || p_campaign_id::text, 'Unspent ad budget returned'
    );
  end if;

  return v_unspent;
end $$;

grant execute on function public.ad_campaign_end(uuid) to authenticated;


-- ─── The guard ──────────────────────────────────────────────────────────────
-- Everything above is pointless if a client can still write these columns
-- directly. This is the lock.
create or replace function public.ad_campaigns_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.promo_trusted() then return new; end if;

  if tg_op = 'INSERT' then
    -- Ad campaigns are still created client-side (the creative upload flow needs
    -- a row to attach to), but only ever UNFUNDED and INACTIVE. Money and
    -- go-live both require ad_campaign_fund_with_credits.
    if new.kind is distinct from 'ad' then raise exception 'spotlight_must_use_rpc'; end if;
    if coalesce(new.status, 'pending') <> 'pending' then raise exception 'must_start_pending'; end if;
    new.budget_cents_total := null;
    new.spent_cents        := 0;
    new.spent_millicents   := 0;
    new.bid_cpm_cents      := null;
    new.price_cents        := 0;
    return new;
  end if;

  -- UPDATE: the owner may pause, resume, end, and edit presentation. Nothing
  -- else. Note `is distinct from` throughout — plain <> is null-blind, and most
  -- of these columns are nullable.
  if new.budget_cents_total is distinct from old.budget_cents_total
     or new.spent_cents      is distinct from old.spent_cents
     or new.spent_millicents is distinct from old.spent_millicents
     or new.bid_cpm_cents    is distinct from old.bid_cpm_cents
     or new.price_cents      is distinct from old.price_cents
     or new.weight           is distinct from old.weight
     or new.package_key      is distinct from old.package_key
     or new.duration_days    is distinct from old.duration_days
     or new.ends_at          is distinct from old.ends_at
     or new.starts_at        is distinct from old.starts_at
  then
    raise exception 'protected_column';
  end if;

  if new.status is distinct from old.status
     and not (old.status in ('active', 'paused') and new.status in ('active', 'paused', 'ended'))
  then
    raise exception 'bad_status_transition';
  end if;

  return new;
end $$;

drop trigger if exists ad_campaigns_guard_trg on public.ad_campaigns;
create trigger ad_campaigns_guard_trg before insert or update on public.ad_campaigns
  for each row execute function public.ad_campaigns_guard();


-- The Premium monthly free Spotlight is a legitimate $0 campaign, and the guard
-- above would otherwise reject it — it inserts a spotlight row directly. Same
-- function as spotlight_credit.sql, with the trusted flag set before the insert.
-- (It already used this exact transaction-local flag pattern for the profiles
-- trigger, so this is the existing convention rather than a new one.)
--
-- ⚠️ If spotlight_credit.sql is ever re-run AFTER this file, it will overwrite
-- this version and the free claim will start failing with 'spotlight_must_use_rpc'.
create or replace function public.claim_free_spotlight(p_post_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_month text := to_char(now(), 'YYYY-MM');
  v_used  text;
  v_id    uuid;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  if not public.is_premium(v_uid) then raise exception 'not_premium'; end if;

  select p.spotlight_credit_used_month into v_used
    from public.profiles p where p.id = v_uid for update;
  if v_used = v_month then raise exception 'already_claimed'; end if;

  if not exists (
    select 1 from public.posts po
     where po.id = p_post_id and po.user_id = v_uid and po.is_public = true
  ) then
    raise exception 'invalid_post';
  end if;

  perform set_config('laybell.promo_trusted', 'on', true);
  insert into public.ad_campaigns
    (user_id, kind, post_id, package_key, duration_days, price_cents, weight, status, starts_at, ends_at)
  values
    (v_uid, 'spotlight', p_post_id, '1d', 1, 0, 2, 'active', now(), now() + interval '1 day')
  returning id into v_id;

  perform set_config('app.claiming_spotlight', '1', true);
  update public.profiles p set spotlight_credit_used_month = v_month where p.id = v_uid;

  return v_id;
end; $$;

grant execute on function public.claim_free_spotlight(uuid) to authenticated;


-- ad_payments was entirely self-service: any amount, any provider, status
-- 'succeeded'. It is a receipt, and receipts are written by the seller.
drop policy if exists "Payments are server-written" on public.ad_payments;
create policy "Payments are server-written"
  on public.ad_payments as restrictive for insert
  to authenticated with check (false);

drop policy if exists "Payments are not client-editable" on public.ad_payments;
create policy "Payments are not client-editable"
  on public.ad_payments as restrictive for update
  to authenticated using (false);


-- ─── Don't destroy a paid promotion ─────────────────────────────────────────
-- ad_campaigns.post_id was ON DELETE CASCADE, so deleting a promoted post
-- deleted the paid campaign outright — no refund, no record, and no way to know
-- it had happened. The app raises a warning dialog first, which is a UX
-- affordance, not a control. Now the campaign survives its post.
do $$
begin
  alter table public.ad_campaigns drop constraint if exists ad_campaigns_post_id_fkey;
  alter table public.ad_campaigns
    add constraint ad_campaigns_post_id_fkey
    foreign key (post_id) references public.posts(id) on delete set null;
exception when others then
  raise notice 'post_id FK not re-pointed (%). Check it by hand.', sqlerrm;
end $$;


-- ─── Verify ─────────────────────────────────────────────────────────────────
--   select * from public.spotlight_package('7d');   -- 4999 | 7.0 | 4
--   select public.ad_min_budget_cents();            -- 500
--   select public.ad_default_cpm_cents();           -- 1000
--
-- The holes should now be shut. Each of these must FAIL:
--   insert into public.ad_campaigns (user_id, kind, status, price_cents, ends_at)
--   values (auth.uid(), 'spotlight', 'active', 0, now() + interval '365 days');
--     → spotlight_must_use_rpc
--
--   update public.ad_campaigns set spent_millicents = 0 where user_id = auth.uid();
--     → protected_column
--
--   insert into public.ad_payments (user_id, amount_cents, status)
--   values (auth.uid(), 9999, 'succeeded');
--     → new row violates row-level security policy
