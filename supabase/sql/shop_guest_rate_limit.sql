-- GUEST CHECKOUT RATE LIMIT — anti-abuse for the --no-verify-jwt guest edge fns
-- (shop-guest-checkout + shop-guest-cart-checkout). Without this, anon can mint UNBOUNDED
-- pending intents/carts/Stripe sessions (resource/DoS; no money moves). Per-IP fixed-window
-- counter, checked BEFORE the begin RPC so the expensive work never runs when abused.
-- NOT money code — no ledger/order/counter writes. Idempotent; re-runnable.

create table if not exists public.shop_guest_rl (
  ip           text not null,
  window_start timestamptz not null,
  count        int not null default 0,
  primary key (ip, window_start)
);
create index if not exists shop_guest_rl_window_idx on public.shop_guest_rl (window_start);
-- Service-role only (the edge fns call it); no app role touches this table.
alter table public.shop_guest_rl enable row level security;

-- Atomically count a hit for this IP in the current fixed window; return TRUE if still within
-- the limit, FALSE if the IP has exceeded it. Fails OPEN when the IP is unknown (never block a
-- legit buyer we can't identify). Opportunistic, cheap GC of stale buckets.
create or replace function public.shop_guest_rl_hit(p_ip text, p_max int default 15, p_window_secs int default 3600)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bucket timestamptz;
  v_count  int;
begin
  if p_ip is null or btrim(p_ip) = '' then return true; end if;   -- unidentifiable → fail open
  if p_max is null or p_max < 1 then p_max := 15; end if;
  if p_window_secs is null or p_window_secs < 1 then p_window_secs := 3600; end if;

  v_bucket := to_timestamp(floor(extract(epoch from now()) / p_window_secs) * p_window_secs);

  insert into public.shop_guest_rl (ip, window_start, count)
    values (btrim(p_ip), v_bucket, 1)
    on conflict (ip, window_start) do update set count = shop_guest_rl.count + 1
    returning count into v_count;

  -- ~1% of calls, sweep buckets older than a day (bounded by the window index).
  if random() < 0.01 then
    delete from public.shop_guest_rl where window_start < now() - interval '1 day';
  end if;

  return v_count <= p_max;
end $$;

revoke all on function public.shop_guest_rl_hit(text, int, int) from public, anon, authenticated;

-- Checking it:
--   select * from public.shop_guest_rl order by window_start desc limit 20;
--   select public.shop_guest_rl_hit('test-ip', 3, 3600);  -- 4th call in the window returns false
-- Rollback:
--   drop function if exists public.shop_guest_rl_hit(text,int,int);
--   drop table if exists public.shop_guest_rl;
