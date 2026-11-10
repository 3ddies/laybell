-- ⚠️ MONEY-ADJACENT (shop domain). Append-only, moves NO money — it only writes
-- the seller a 'sale' notification when one of their beats is delivered. Still, it
-- runs inside the delivery transaction, so review it before it goes live
-- ("always review money code before it runs"). Deploy after notif_types_repost_react_sale.sql.
--
--   npx supabase db query --remote --yes -f supabase/sql/sale_notification.sql
--
-- WHY A TRIGGER (not a client createNotification): a sale completes server-side,
-- in the service-role deliver RPCs (shop_iap / shop_credits / shop_stripe /
-- offer accept). There is no buyer client to fire the notification, so the DB does.
--
-- FIRES ON BOTH DELIVERY PATHS. shop_stats.sql delivers an order two ways:
--   • INSERT straight as 'delivered' (shop_order_precheck — instant digital sale), and
--   • UPDATE pending → 'delivered' (shop_order_delivered — async / offer accept).
-- A UPDATE-only trigger would miss every instant sale, so this one fires AFTER
-- INSERT OR UPDATE and keys off the transition INTO delivered, exactly once per sale.
--
-- PRIVACY: like 'offer', the row names the buyer and nothing else — no amount. The
-- figure is on the seller's /wallet, which the row opens; a lock screen is read by
-- whoever is holding the phone.

create or replace function public.shop_sale_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only on the transition into 'delivered', and never a self-sale (can't buy your
  -- own listing, but guard anyway so a self-notify can never happen).
  if new.status = 'delivered'
     and (tg_op = 'INSERT' or old.status is distinct from 'delivered')
     and new.seller_id is distinct from new.buyer_id then
    -- Best-effort: a notification must NEVER roll back a completed, paid sale.
    begin
      insert into public.notifications (user_id, actor_id, type)
      values (new.seller_id, new.buyer_id, 'sale');
    exception when others then
      -- swallow — the money already moved; the notification is a courtesy
      null;
    end;
  end if;
  return null; -- AFTER trigger
end;
$$;

drop trigger if exists shop_orders_sale_notify on public.shop_orders;
create trigger shop_orders_sale_notify
  after insert or update on public.shop_orders
  for each row execute function public.shop_sale_notify();
