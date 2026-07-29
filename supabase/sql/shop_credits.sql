-- Shop purchases through credits.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
-- REQUIRES: ledger.sql, ledger_spend.sql, payouts.sql, shop.sql, shop_multi.sql.
--
-- WHY THIS CHANGED
-- The shop used to be a venue: `requestToBuy` inserted an order and sent the
-- seller a DM, and the two of them settled up privately. Laybell touched no
-- money and earned none — the "Earned" figure on the shop screen was 85% of
-- cash that had never passed through Laybell.
--
-- That is not survivable at review time. The buyer pays outside the app, but the
-- FILE IS DELIVERED INSIDE IT via a signed storage URL, and selling digital
-- goods with in-app delivery is what Guideline 3.1.1 exists to stop. Apple
-- forced Patreon onto IAP for exactly this. Physical-goods marketplaces are fine
-- because the goods are physical; a beat is not.
--
-- So purchases now spend credits, which are bought through Apple and Google.
-- Two things fall out of that, both good: Apple becomes merchant of record and
-- handles the sales tax that would otherwise make Laybell a marketplace
-- facilitator, and the money is finally real.
--
-- ─── THE FEE HAD TO CHANGE, AND HERE IS THE ARITHMETIC ──────────────────────
-- The old 15% fee predates credits, and against IAP funding it earns nothing:
--
--   $10 beat = 1000 credits
--   Buyer paid Apple $10 → Apple keeps 15% → LAYBELL RECEIVED $8.50
--   Seller is owed 85% of 1000 credits                    = $8.50
--   Laybell keeps                                         = $0.00
--
-- The platform fee and the store commission cancel out exactly. At 25%:
--
--   Laybell received $8.50, owes the seller 75% = $7.50 → nets $1.00 (10% gross)
--
-- 75% to the seller is below BeatStars (~90%) and Bandcamp (~82-85%), and that
-- gap is Apple's commission, not greed. The seller UI states the split plainly
-- rather than letting them discover it at payout — a creator who expected 90%
-- and got 75% churns, and tells people why.
--
-- ⚠️ ENROLL IN THE APP STORE SMALL BUSINESS PROGRAM. It moves Apple's cut from
-- 30% to 15% for under $1M/year. Every number above assumes 15%. At 30% the
-- seller's 75% would cost Laybell money on every sale.
--
-- The rate is a function, not a constant, so it can be repriced without a deploy.

create or replace function public.shop_fee_rate()
returns numeric language sql immutable as $$ select 0.25 $$;


-- ─── Buying ─────────────────────────────────────────────────────────────────
-- Deliberately inserts the order and lets `shop_order_precheck` (shop_multi.sql)
-- run, rather than re-deriving anything. That trigger is already the authority
-- on which deal types a listing offers, what each costs, and whether the free
-- unlock conditions are met — duplicating that logic here would mean two
-- versions of it drifting apart, and the price is the one number that must never
-- be wrong.
--
-- The client passes a listing and a kind. It does NOT pass a price, and the fee
-- is recomputed here: `shop_orders.fee_cents` used to be whatever the client
-- sent, which was harmless when no money moved and is not harmless now.
create or replace function public.shop_buy_with_credits(
  p_listing_id  uuid,
  p_kind        text,
  p_offer_cents int default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_buyer  uuid := auth.uid();
  v_seller uuid;
  v_order  public.shop_orders%rowtype;
  v_fee    bigint;
  v_payout bigint;
  v_tx     uuid;
begin
  if v_buyer is null then raise exception 'not_signed_in'; end if;
  if p_kind not in ('sell', 'lease', 'free', 'offer') then raise exception 'bad_kind'; end if;

  select l.user_id into v_seller from public.shop_listings l where l.id = p_listing_id;
  if v_seller is null then raise exception 'listing_not_found'; end if;
  if v_seller = v_buyer then raise exception 'cannot_buy_own'; end if;

  insert into public.shop_orders (listing_id, buyer_id, seller_id, kind, price_cents, status)
  values (
    p_listing_id, v_buyer, v_seller, p_kind,
    -- Only offers carry a client-named price, and the trigger rejects a
    -- non-positive one. Every other kind is overwritten by the trigger.
    case when p_kind = 'offer' then coalesce(p_offer_cents, 0) else 0 end,
    'requested'
  )
  returning * into v_order;

  -- Free claims: the trigger already verified the follow/like conditions and
  -- delivered. No money exists to move.
  if p_kind = 'free' then
    return jsonb_build_object('ok', true, 'order_id', v_order.id, 'price_cents', 0, 'delivered', true);
  end if;

  v_fee    := round(v_order.price_cents * public.shop_fee_rate());
  v_payout := v_order.price_cents - v_fee;

  if p_kind = 'offer' then
    -- An offer needs the seller's agreement, so the credits are held rather than
    -- paid: buyer → platform now, platform → seller on acceptance, platform →
    -- buyer on decline. Holding at offer time is what stops a seller accepting
    -- an offer the buyer has since spent the credits for.
    v_tx := public.ledger_post(
      'purchase',
      jsonb_build_array(
        jsonb_build_object('user', v_buyer, 'kind', 'credits',  'amount_cents', -v_order.price_cents),
        jsonb_build_object('user', null,    'kind', 'platform', 'amount_cents',  v_order.price_cents)
      ),
      'internal', 'shop-offer:' || v_order.id::text, 'Shop offer held'
    );
    update public.shop_orders o set fee_cents = v_fee where o.id = v_order.id;
    return jsonb_build_object('ok', true, 'order_id', v_order.id,
                              'price_cents', v_order.price_cents, 'delivered', false,
                              'transaction_id', v_tx);
  end if;

  -- sell / lease — paid up front, so deliver immediately. The buyer has already
  -- parted with the money; making them wait for the seller to press a button is
  -- the worst of both models.
  v_tx := public.ledger_post(
    'purchase',
    jsonb_build_array(
      jsonb_build_object('user', v_buyer,  'kind', 'credits',  'amount_cents', -v_order.price_cents),
      jsonb_build_object('user', v_seller, 'kind', 'earnings', 'amount_cents',  v_payout,
                         'available_at', now() + (public.payout_hold_days() || ' days')::interval),
      jsonb_build_object('user', null,     'kind', 'platform', 'amount_cents',  v_fee)
    ),
    'internal', 'shop:' || v_order.id::text, 'Shop purchase'
  );

  update public.shop_orders o
     set status = 'delivered', delivered_at = now(), fee_cents = v_fee
   where o.id = v_order.id;

  return jsonb_build_object('ok', true, 'order_id', v_order.id,
                            'price_cents', v_order.price_cents, 'fee_cents', v_fee,
                            'seller_cents', v_payout, 'delivered', true,
                            'transaction_id', v_tx);
end $$;

grant execute on function public.shop_buy_with_credits(uuid, text, int) to authenticated;


-- ─── Settling a held offer ──────────────────────────────────────────────────
-- A trigger rather than an RPC, because the app already flips order status from
-- several places (accept, decline, cancel). Anything that moves an offer out of
-- 'requested' has to settle the escrow, and a trigger cannot be forgotten by a
-- caller that didn't know it existed.
create or replace function public.shop_settle_offer()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_fee    bigint;
  v_payout bigint;
begin
  if new.kind is distinct from 'offer' then return new; end if;
  if old.status <> 'requested' then return new; end if;      -- already settled
  if new.status = old.status then return new; end if;
  if coalesce(new.price_cents, 0) <= 0 then return new; end if;

  if new.status = 'delivered' then
    v_fee    := round(new.price_cents * public.shop_fee_rate());
    v_payout := new.price_cents - v_fee;
    perform public.ledger_post(
      'purchase',
      jsonb_build_array(
        jsonb_build_object('user', null,           'kind', 'platform', 'amount_cents', -new.price_cents),
        jsonb_build_object('user', new.seller_id,  'kind', 'earnings', 'amount_cents',  v_payout,
                           'available_at', now() + (public.payout_hold_days() || ' days')::interval),
        jsonb_build_object('user', null,           'kind', 'platform', 'amount_cents',  v_fee)
      ),
      'internal', 'shop-offer-accept:' || new.id::text, 'Shop offer accepted'
    );
    new.fee_cents := v_fee;

  elsif new.status in ('declined', 'cancelled') then
    -- Give the credits back. A refund, not an edit: ledger entries are
    -- append-only and an `ledger_entries_no_update` trigger rejects UPDATE and
    -- DELETE even for the service role.
    perform public.ledger_post(
      'refund',
      jsonb_build_array(
        jsonb_build_object('user', null,          'kind', 'platform', 'amount_cents', -new.price_cents),
        jsonb_build_object('user', new.buyer_id,  'kind', 'credits',  'amount_cents',  new.price_cents)
      ),
      'internal', 'shop-offer-refund:' || new.id::text, 'Shop offer declined — credits returned'
    );
  end if;

  return new;
end $$;

drop trigger if exists shop_orders_settle_offer on public.shop_orders;
create trigger shop_orders_settle_offer before update on public.shop_orders
  for each row execute function public.shop_settle_offer();


-- ─── Close the old door ─────────────────────────────────────────────────────
-- `requestToBuy` inserted orders straight from the client. With money attached
-- that would let a crafted insert create a delivered order — and delivery is
-- what unlocks the file in storage.
--
-- RESTRICTIVE, so it ANDs with the existing policies rather than offering an
-- alternative way in. Free claims still insert directly: they move no money, and
-- the precheck trigger already enforces the follow/like conditions server-side.
drop policy if exists "Paid orders go through the RPC" on public.shop_orders;
create policy "Paid orders go through the RPC"
  on public.shop_orders as restrictive for insert
  to authenticated
  with check (kind = 'free');


-- ─── Refund policy ──────────────────────────────────────────────────────────
-- There is deliberately no buyer-initiated refund for a DELIVERED sale. The file
-- was handed over the instant the credits moved; a refund after download is
-- indistinguishable from theft, which is why `shop_downloads.sql` logs every
-- download as dispute evidence.
--
-- It is also structurally hard: `ledger_post` refuses to settle a user account
-- negative, so once the seller has spent or withdrawn the money there is nothing
-- to claw back. Any goodwill refund should therefore come from the PLATFORM
-- account (which may go negative by design) and not from the seller:
--
--   select public.ledger_post(
--     'refund',
--     jsonb_build_array(
--       jsonb_build_object('user', null,        'kind', 'platform', 'amount_cents', -1000),
--       jsonb_build_object('user', '<buyer>',   'kind', 'credits',  'amount_cents',  1000)
--     ),
--     'manual', 'goodwill:<order_id>', 'Support refund');


-- ─── Operating it ───────────────────────────────────────────────────────────
--   select date_trunc('day', o.created_at) as day, count(*),
--          sum(o.price_cents)/100.0 as gross, sum(o.fee_cents)/100.0 as laybell
--     from public.shop_orders o
--    where o.status = 'delivered' and o.price_cents > 0
--    group by 1 order by 1 desc limit 30;
--
-- Offers stuck in escrow (seller never responded — consider auto-declining):
--   select * from public.shop_orders
--    where kind = 'offer' and status = 'requested' and created_at < now() - interval '7 days';
--
--   select * from public.ledger_verify();   -- returns rows ONLY on drift
