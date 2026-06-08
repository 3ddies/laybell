-- Public per-post share count (rate-limited) — Supabase
-- Run in the Supabase Dashboard → SQL Editor.
--
-- Shares bump a public counter on the post, but to stop bots/spam from inflating
-- it, each user can register at most 4 shares per post per rolling 12h. The cap
-- is enforced server-side via a SECURITY DEFINER RPC + a per-user share log
-- (mirrors record_stream). The client just calls increment_share_count().

alter table public.posts
  add column if not exists share_count integer not null default 0;

-- Per-user share log, used only to enforce the rate cap.
create table if not exists public.share_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  post_id     uuid not null references public.posts(id) on delete cascade,
  created_at  timestamptz not null default now()
);

create index if not exists share_events_user_post_idx
  on public.share_events(user_id, post_id, created_at);

-- RLS on with no client policies: the only write path is the gatekept RPC below.
alter table public.share_events enable row level security;

create or replace function public.increment_share_count(p_post_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recent int;
  v_created timestamptz;
begin
  if auth.uid() is null then return; end if;
  if not exists (select 1 from public.posts where id = p_post_id) then return; end if;

  -- Anti-fraud: shares from very new accounts don't count (blunts mass alts).
  -- Tune the interval below; set to '0 hours' to disable.
  select created_at into v_created from auth.users where id = auth.uid();
  if v_created is null or now() - v_created < interval '24 hours' then return; end if;

  -- Drop this user's expired rows for the post (keeps the table small + count fast).
  delete from public.share_events
  where user_id = auth.uid() and post_id = p_post_id
    and created_at < now() - interval '12 hours';

  -- Max 4 counted shares per user per post per rolling 12h (anti-bot/spam).
  select count(*) into v_recent
  from public.share_events
  where user_id = auth.uid()
    and post_id = p_post_id
    and created_at > now() - interval '12 hours';
  if v_recent >= 4 then return; end if;

  insert into public.share_events (user_id, post_id) values (auth.uid(), p_post_id);
  update public.posts set share_count = share_count + 1 where id = p_post_id;
end;
$$;

grant execute on function public.increment_share_count(uuid) to authenticated;
