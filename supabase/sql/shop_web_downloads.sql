-- Web delivery helpers: let a buyer LIST and DOWNLOAD the beats they've bought on the
-- web, for any funding rail (credits / IAP / Stripe). Run in the SQL Editor; idempotent.
-- REQUIRES: shop.sql, shop_multi.sql. ⚠️ Touches delivered-order access — review first.
--
-- WHY DEFINER RPCs RATHER THAN A PLAIN JOIN
-- An exclusive sale flips the listing to status='sold', and the shop_listings RLS
-- ("Active listings are public using status='active' or user_id=auth.uid()") then HIDES
-- that row from the buyer — so a plain client join to show "your purchases" returns
-- nothing for the very beats they paid for. These SECURITY DEFINER functions read the
-- listing on the buyer's behalf, but ONLY for orders that are theirs and delivered.
--
-- file_path is NOT a secret: the actual file in the private 'shop-files' bucket is gated
-- by storage RLS (seller + buyers of a delivered order), so returning the path to a
-- verified buyer lets the client createSignedUrl() while a non-buyer still gets nothing.

-- Everything the /purchases page shows: the caller's own delivered orders + listing
-- display info. No file_path here — that comes per-download from the function below.
create or replace function public.my_shop_purchases()
returns table (
  order_id     uuid,
  kind         text,
  price_cents  int,
  created_at   timestamptz,
  listing_id   uuid,
  title        text,
  cover_url    text,
  category     text,
  seller_username text
)
language sql
stable
security definer
set search_path = public
as $$
  select o.id, o.kind, o.price_cents, o.created_at,
         l.id, l.title, l.cover_url, l.category, p.username
    from public.shop_orders o
    join public.shop_listings l on l.id = o.listing_id
    left join public.profiles p on p.id = l.user_id
   where o.buyer_id = auth.uid()
     and o.status = 'delivered'
     and o.price_cents > 0          -- paid purchases; free claims list elsewhere in-app
   order by o.created_at desc;
$$;

grant execute on function public.my_shop_purchases() to authenticated;
revoke all on function public.my_shop_purchases() from public, anon;

-- The private deliverable path for one delivered order the CALLER owns. The client then
-- calls storage.createSignedUrl(path) — which storage RLS permits only for a buyer with
-- a delivered order, so this function + that policy both have to agree before a byte moves.
create or replace function public.shop_deliverable_path(p_order_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_path text;
begin
  select l.file_path into v_path
    from public.shop_orders o
    join public.shop_listings l on l.id = o.listing_id
   where o.id = p_order_id
     and o.buyer_id = auth.uid()
     and o.status = 'delivered';
  if v_path is null then raise exception 'not_found'; end if;
  return v_path;
end $$;

grant execute on function public.shop_deliverable_path(uuid) to authenticated;
revoke all on function public.shop_deliverable_path(uuid) from public, anon;

-- Rollback:
--   drop function if exists public.my_shop_purchases(), public.shop_deliverable_path(uuid);
