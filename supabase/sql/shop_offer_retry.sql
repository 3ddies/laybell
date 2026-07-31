-- One LIVE order per kind, instead of one order per kind ever.
-- Run AFTER shop_exclusivity_lock.sql. Idempotent.
--
-- THE BUG
--   shop_multi.sql created this index so a buyer could hold one order per kind
--   on a listing — lease it now, buy it later. Correct intent, but it counts
--   DEAD orders too: declined, cancelled, refunded, and now expired.
--
--   So the first offer a buyer makes permanently consumes their only 'offer'
--   slot on that listing. Seller declines it? They can never offer again. It
--   expires unanswered after 24h? Same. The app shows them the Make an offer
--   button, they type a price, and the insert fails on a unique violation with
--   nothing useful to say.
--
--   Offer expiry (offer_expiry.sql) turned this from an edge case into the
--   normal path: every offer nobody answers ends up dead, and every buyer who
--   lets one lapse is locked out of that listing for good.
--
-- THE FIX
--   Scope the index to orders that are still live. A dead order stops occupying
--   the slot, so the buyer can try again; a live one still does, so nothing that
--   was prevented before becomes possible now:
--     * two pending offers on one listing — still impossible,
--     * leasing the same beat twice — still impossible (a delivered lease is
--       live and holds the slot),
--     * re-claiming a freebie — still impossible, same reason.
--
--   A refunded order does free its slot, which is right: the money went back, so
--   the buyer holds nothing. Re-buying an exclusive that way is not a hole — an
--   exclusive sale leaves the listing 'sold', and the precheck refuses every
--   order on a listing that is not active.

do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'shop_orders'
                   and column_name = 'kind') then
    raise exception 'run shop_multi.sql first';
  end if;
end $$;

drop index if exists shop_orders_listing_buyer_kind_uq;
create unique index shop_orders_listing_buyer_kind_uq
  on public.shop_orders (listing_id, buyer_id, coalesce(kind, 'legacy'))
  where status in ('requested', 'delivered');

-- ── Checking it ───────────────────────────────────────────────────────────────
--   The index is scoped (expect one row, with a WHERE clause in the definition):
--     select indexdef from pg_indexes
--      where indexname = 'shop_orders_listing_buyer_kind_uq';
--
--   Buyers who had been locked out — each of these can now offer again:
--     select o.buyer_id, o.listing_id, o.status
--       from public.shop_orders o
--      where o.kind = 'offer'
--        and o.status in ('declined', 'cancelled', 'expired', 'refunded');
--
--   Nothing live is duplicated (should return NO rows):
--     select listing_id, buyer_id, coalesce(kind, 'legacy') as k, count(*)
--       from public.shop_orders
--      where status in ('requested', 'delivered')
--      group by 1, 2, 3 having count(*) > 1;
