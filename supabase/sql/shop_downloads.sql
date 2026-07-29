-- Shop download log — evidence for payment disputes.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
-- Requires shop.sql (shop_orders) to have run first.
--
-- WHY THIS EXISTS: a beat is delivered instantly, is non-returnable, and is
-- infinitely copyable — the worst possible shape for a card dispute. When Laybell
-- moves to real payments with Stripe destination charges, the PLATFORM balance is
-- debited on a chargeback, and recovery depends on reversing the seller's transfer
-- while they still have a balance. The single piece of evidence that wins these
-- disputes is Stripe's `access_activity_log` field: server logs proving the buyer
-- accessed or downloaded the product after paying, with IP addresses and
-- timestamps. Without this table that evidence does not exist and every dispute is
-- conceded by default.
--
-- Append-only by design: rows are inserted by the buyer at download time and can
-- never be updated or deleted by any client. Nothing here is shown in the UI — it
-- exists purely to be exported when a dispute arrives.

create table if not exists public.shop_downloads (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references public.shop_orders(id) on delete cascade,
  buyer_id     uuid not null references auth.users(id) on delete cascade,
  -- Which file was handed over, so a multi-file or re-listed order stays unambiguous.
  file_path    text,
  -- Captured client-side and therefore ADVISORY, not authoritative: a determined
  -- buyer can lie about their own user agent. The timestamp, the order linkage and
  -- the authenticated buyer_id are the parts that carry weight in a dispute.
  user_agent   text,
  platform     text,
  downloaded_at timestamptz not null default now()
);

create index if not exists shop_downloads_order_idx on public.shop_downloads (order_id);
create index if not exists shop_downloads_buyer_idx on public.shop_downloads (buyer_id, downloaded_at desc);

alter table public.shop_downloads enable row level security;

-- A buyer may record ONLY their own download, and only against an order that is
-- actually theirs and actually delivered. This is what makes a row meaningful as
-- evidence: it cannot be fabricated for someone else's order.
drop policy if exists "Buyers log their own downloads" on public.shop_downloads;
create policy "Buyers log their own downloads"
  on public.shop_downloads for insert
  with check (
    buyer_id = auth.uid()
    and exists (
      select 1 from public.shop_orders o
      where o.id = public.shop_downloads.order_id
        and o.buyer_id = auth.uid() and o.status = 'delivered'
    )
  );

-- Buyer sees their own history; the seller sees downloads of their own orders
-- (they need it to answer a "never received it" claim). Deliberately no update or
-- delete policy anywhere — the log is append-only for everyone, including the
-- people it is about.
drop policy if exists "Download log is visible to the parties" on public.shop_downloads;
create policy "Download log is visible to the parties"
  on public.shop_downloads for select
  using (
    buyer_id = auth.uid()
    or exists (
      select 1 from public.shop_orders o
      where o.id = public.shop_downloads.order_id and o.seller_id = auth.uid()
    )
  );

-- Export for a dispute (run from the dashboard, service role):
--   select d.downloaded_at, d.buyer_id, d.file_path, d.user_agent, d.platform,
--          o.price_cents, o.created_at as ordered_at
--   from public.shop_downloads d
--   join public.shop_orders o on o.id = d.order_id
--   where o.id = '<order uuid>'
--   order by d.downloaded_at;
