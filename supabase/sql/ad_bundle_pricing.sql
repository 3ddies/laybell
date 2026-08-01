-- Ad bundle pricing + Simple shop ads — server side.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
-- REQUIRES (in this order, already applied): spotlight.sql, ad_ecosystem.sql,
-- promo_credits.sql, money_hardening_2026-07-29.sql. This file REDEFINES
-- ad_campaign_fund_with_credits (last defined in promo_credits.sql) and
-- ad_campaign_end (last defined in money_hardening_2026-07-29.sql) — if either
-- of THOSE files is ever re-run after this one, re-run THIS file too.
--
-- WHAT CHANGES
--
-- 1. PER-PLACEMENT MINIMUM. The old minimum was a flat $5. Now every placement
--    in the bundle raises the floor by $20: 1 placement = $20, 2 = $40,
--    3 = $60, 4 = $80. Oversaturated shotgun campaigns need real money behind
--    them; serious single-surface ads barely notice.
--
-- 2. MULTI-PLACEMENT DISCOUNT, OFF THE CHARGE. Bundles wider than one
--    placement pay less than their budget: 5% off for 2 placements, 10% for 3,
--    15% for 4. The BUDGET stays the delivery meter (spend accrues against it
--    unchanged); the discount reduces what is debited from credits. The
--    ad_payments receipt records the ACTUAL charge, which is what the refund
--    math below keys off.
--
-- 3. PRO-RATA REFUNDS. ad_campaign_end used to refund `budget - spent`. With a
--    discounted charge that would MINT money: fund an $80 budget for $68 (15%
--    off), end it immediately, get $80 back — $12 created from nothing. The
--    refund is now the unspent SHARE of what was actually PAID:
--    floor(paid × unspent / budget), capped at paid. Undiscounted campaigns
--    (paid == budget) refund exactly as before.
--
-- 4. SIMPLE SHOP ADS. ad_creatives grows two nullable columns:
--    song_url   — the shop listing's preview clip; plays as the ad's song in
--                 the feed strip, as the reels/TV soundtrack, and as the music
--                 break itself.
--    listing_id — the featured listing; the CTA deep-links to the product.
--    Old clients ignore both; lib/ads.ts falls back gracefully until applied.
--
-- 5. CREATIVES FREEZE AT FUNDING. The minimum is counted per placement, and
--    creatives used to be insertable at ANY time — declare one placement, pay
--    its $20 floor, then add creatives for three more surfaces after going
--    live. The funding RPC now counts placements as the max of the campaign's
--    placements[] and the DISTINCT creative placements already inserted, and
--    the creative INSERT policy only accepts rows while the campaign is still
--    'pending' (the create flow inserts creatives before funding, so nothing
--    legitimate changes).

-- ─── dependency guard ─────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'ad_creatives'
  ) then
    raise exception 'Run ad_ecosystem.sql before ad_bundle_pricing.sql (public.ad_creatives is missing).';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'ad_campaign_fund_with_credits'
  ) then
    raise exception 'Run promo_credits.sql before ad_bundle_pricing.sql (ad_campaign_fund_with_credits is missing).';
  end if;
end $$;

-- ─── Simple shop ad columns ───────────────────────────────────────────────────
alter table public.ad_creatives add column if not exists song_url   text;
alter table public.ad_creatives add column if not exists listing_id uuid;

-- FK only when the shop exists (shop.sql) — ON DELETE SET NULL, so removing a
-- listing never tears down a paid campaign; the ad's CTA just falls back to
-- the advertiser's shop (lib/ads.adDestination).
do $$
begin
  if exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'shop_listings'
  ) and not exists (
    select 1 from pg_constraint
     where conname = 'ad_creatives_listing_id_fkey' and conrelid = 'public.ad_creatives'::regclass
  ) then
    alter table public.ad_creatives
      add constraint ad_creatives_listing_id_fkey
      foreign key (listing_id) references public.shop_listings(id) on delete set null;
  end if;
end $$;

-- ─── Bundle pricing functions ─────────────────────────────────────────────────
-- $20 per placement, floored at the legacy $5 absolute minimum. KEEP IN SYNC
-- with lib/ads.ts adMinBudgetCents / AD_MIN_BUDGET_PER_PLACEMENT_CENTS.
create or replace function public.ad_min_budget_cents(p_placement_count int)
returns int language sql immutable as $$
  select greatest(500, 2000 * greatest(1, coalesce(p_placement_count, 1)))
$$;

-- 5% / 10% / 15% off the CHARGE for 2 / 3 / 4 placements. KEEP IN SYNC with
-- lib/ads.ts adBundleDiscount.
create or replace function public.ad_bundle_discount_pct(p_placement_count int)
returns numeric language sql immutable as $$
  select case
    when coalesce(p_placement_count, 1) >= 4 then 0.15
    when p_placement_count = 3 then 0.10
    when p_placement_count = 2 then 0.05
    else 0
  end
$$;

-- ─── Funding: per-placement minimum + discounted charge ───────────────────────
-- Same shape as promo_credits.sql's version; the differences are the placement
-- count (campaign placements[] vs distinct inserted creatives — whichever is
-- larger, so under-declaring placements can't dodge the minimum), the minimum
-- itself, and the charge being the discounted amount while budget_cents_total
-- keeps the full budget as the delivery meter.
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
  v_user   uuid := auth.uid();
  v_camp   public.ad_campaigns%rowtype;
  v_creative_places int := 0;
  v_count  int;
  v_charge int;
begin
  if v_user is null then raise exception 'not_signed_in'; end if;

  select * into v_camp from public.ad_campaigns c
   where c.id = p_campaign_id and c.user_id = v_user for update;
  if not found then raise exception 'campaign_not_found'; end if;
  if v_camp.status <> 'pending' then raise exception 'already_funded'; end if;

  select count(distinct cr.placement) into v_creative_places
    from public.ad_creatives cr where cr.campaign_id = p_campaign_id;

  v_count := greatest(1, coalesce(array_length(v_camp.placements, 1), 0), coalesce(v_creative_places, 0));

  -- Same error string the client already maps to a friendly message.
  if p_budget_cents < public.ad_min_budget_cents(v_count) then raise exception 'below_minimum'; end if;

  -- Bundle discount comes off the CHARGE; ceil so rounding never under-charges
  -- (mirrors lib/ads.adChargedCents).
  v_charge := ceil(p_budget_cents * (1 - public.ad_bundle_discount_pct(v_count)))::int;

  perform set_config('laybell.promo_trusted', 'on', true);

  update public.ad_campaigns c
     set budget_cents_total = p_budget_cents,
         bid_cpm_cents      = public.ad_default_cpm_cents(),
         spent_cents        = 0,
         spent_millicents   = 0,
         status             = 'active'
   where c.id = p_campaign_id;

  perform public.ledger_post(
    'promotion',
    jsonb_build_array(
      jsonb_build_object('user', v_user, 'kind', 'credits',  'amount_cents', -v_charge),
      jsonb_build_object('user', null,   'kind', 'platform', 'amount_cents',  v_charge)
    ),
    'internal', 'ad:' || p_campaign_id::text, 'Ad campaign budget'
  );

  -- The receipt records what was ACTUALLY paid — ad_campaign_end reads it to
  -- pro-rate refunds, so a discounted campaign can never refund more than in.
  insert into public.ad_payments (user_id, campaign_id, amount_cents, provider, status)
  values (v_user, p_campaign_id, v_charge, 'credits', 'succeeded');
end $$;

grant execute on function public.ad_campaign_fund_with_credits(uuid, int) to authenticated;

-- ─── Ending: refund the unspent share of what was PAID ────────────────────────
-- Base version: money_hardening_2026-07-29.sql H2 ('ended' accepted, refund
-- idempotent via the ledger external_id). Changed only in HOW MUCH comes back:
-- floor(paid × unspent / budget) instead of raw unspent — identical when the
-- charge equalled the budget (every pre-discount campaign), strictly safe when
-- it didn't.
create or replace function public.ad_campaign_end(p_campaign_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    uuid := auth.uid();
  v_camp    public.ad_campaigns%rowtype;
  v_unspent bigint;
  v_paid    bigint;
  v_refund  bigint := 0;
begin
  if v_user is null then raise exception 'not_signed_in'; end if;

  select * into v_camp from public.ad_campaigns c
   where c.id = p_campaign_id and c.user_id = v_user for update;
  if not found then raise exception 'campaign_not_found'; end if;
  if v_camp.kind is distinct from 'ad' then return 0; end if;
  if v_camp.status not in ('active', 'paused', 'ended') then return 0; end if;

  v_unspent := greatest(0, coalesce(v_camp.budget_cents_total, 0) - coalesce(v_camp.spent_cents, 0));

  select coalesce(sum(a.amount_cents), 0) into v_paid
    from public.ad_payments a
   where a.campaign_id = p_campaign_id and a.status = 'succeeded';

  if v_unspent > 0 and v_paid > 0 and coalesce(v_camp.budget_cents_total, 0) > 0 then
    v_refund := least(v_paid, floor(v_paid::numeric * v_unspent / v_camp.budget_cents_total)::bigint);
  end if;

  perform set_config('laybell.promo_trusted', 'on', true);
  if v_camp.status <> 'ended' then
    update public.ad_campaigns c set status = 'ended' where c.id = p_campaign_id;
  end if;

  if v_refund > 0 then
    perform public.ledger_post(
      'refund',
      jsonb_build_array(
        jsonb_build_object('user', null,   'kind', 'platform', 'amount_cents', -v_refund),
        jsonb_build_object('user', v_user, 'kind', 'credits',  'amount_cents',  v_refund)
      ),
      'internal', 'ad-refund:' || p_campaign_id::text, 'Unspent ad budget returned'
    );
  end if;

  return v_refund;
end $$;

grant execute on function public.ad_campaign_end(uuid) to authenticated;

-- ─── Creatives freeze at funding ──────────────────────────────────────────────
-- Owners may only INSERT creatives while the campaign is still 'pending'. The
-- create flow inserts every creative before ad_campaign_fund_with_credits runs,
-- so the legitimate path is untouched — what this closes is topping up a live
-- campaign with extra placements the minimum was never paid for.
drop policy if exists "Owners write own ad creatives" on public.ad_creatives;
create policy "Owners write own ad creatives"
on public.ad_creatives for insert
with check (
  exists (
    select 1 from public.ad_campaigns c
     where c.id = campaign_id and c.user_id = auth.uid() and c.status = 'pending'
  )
);

-- ─── Verify ───────────────────────────────────────────────────────────────────
--   select public.ad_min_budget_cents(1);  -- 2000
--   select public.ad_min_budget_cents(4);  -- 8000
--   select public.ad_bundle_discount_pct(2); -- 0.05
--
--   Fund a 2-placement campaign with an $80.00 budget → ledger debit is $76.00
--   (5% off), ad_payments.amount_cents = 7600, budget_cents_total = 8000.
--   End it with $0 spent → refund is 7600 (all of what was paid), NOT 8000.
--   End it again → 7600 returned by the function but the ledger external_id
--   dedupes, so no second credit lands.
