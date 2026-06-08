-- Video view counting — Supabase
-- Run in the Supabase Dashboard → SQL Editor.
--
-- Mirrors the stream system (streams_dedup.sql + record_stream_rpc.sql) but for
-- video watches. The client credits a view by cumulative watch time (see
-- lib/playThresholds + lib/viewTracker) and calls record_view(); the server
-- enforces the same fairness/anti-fraud rules:
--   * No self-views.
--   * Age-based per-user cap per rolling 24h: <24h accounts = 2 (1st + 2nd),
--     >=24h accounts = 3 (one extra). Account age is server-truth (unspoofable).
--   * Per-device cap: max 4 per device per video per 24h.
-- A counted view inserts a `views` row, which trips bump_view_count.

alter table public.posts
  add column if not exists view_count integer not null default 0;

create table if not exists public.views (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  post_id uuid not null references public.posts(id) on delete cascade,
  device_id text,
  created_at timestamptz not null default now()
);

create index if not exists views_user_post_idx   on public.views (user_id, post_id, created_at);
create index if not exists views_device_post_idx on public.views (device_id, post_id, created_at);

alter table public.views enable row level security;
-- Writes only happen via the gatekept RPC below (SECURITY DEFINER), so no client
-- insert policy. Allow users to read their own rows (parity with streams).
create policy "Users read own views" on public.views
  for select using (auth.uid() = user_id);

-- Bump the public counter on each counted view (INSERT only — never decremented,
-- so purging old rows in the RPC never changes the total).
create or replace function public.bump_view_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.posts set view_count = view_count + 1 where id = new.post_id;
  return null;
end;
$$;

drop trigger if exists trg_bump_view_count on public.views;
create trigger trg_bump_view_count
after insert on public.views
for each row execute function public.bump_view_count();

create or replace function public.record_view(p_post_id uuid, p_device_id text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_recent int;
  v_dev int;
  v_created timestamptz;
  v_cap int;
begin
  if auth.uid() is null then return; end if;

  select user_id into v_owner from public.posts where id = p_post_id;
  if v_owner is null then return; end if;
  if v_owner = auth.uid() then return; end if;            -- no self-views

  -- Age-based cap: new accounts (<24h) earn the standard 1st + 2nd view (cap 2);
  -- accounts older than 24h earn one extra (cap 3). Account age is unspoofable.
  select created_at into v_created from auth.users where id = auth.uid();
  if v_created is not null and now() - v_created >= interval '24 hours' then
    v_cap := 3;
  else
    v_cap := 2;
  end if;

  delete from public.views
  where user_id = auth.uid() and post_id = p_post_id
    and created_at < now() - interval '24 hours';

  select count(*) into v_recent
  from public.views
  where user_id = auth.uid() and post_id = p_post_id
    and created_at > now() - interval '24 hours';
  if v_recent >= v_cap then return; end if;

  if p_device_id is not null then
    select count(*) into v_dev
    from public.views
    where device_id = p_device_id and post_id = p_post_id
      and created_at > now() - interval '24 hours';
    if v_dev >= 4 then return; end if;
  end if;

  insert into public.views (user_id, post_id, device_id) values (auth.uid(), p_post_id, p_device_id);
end;
$$;

grant execute on function public.record_view(uuid, text) to authenticated;
