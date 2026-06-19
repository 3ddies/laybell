-- Anti-spam stream recording — Supabase
-- Run in the Supabase Dashboard → SQL Editor.
--
-- Replaces the direct `streams` insert from the client with a gatekept RPC so the
-- rules are enforced server-side (a client can't bypass them):
--   * Self-streams count ONCE: the post owner listening to their own track earns
--     exactly one stream, ever (a hard lifetime cap of 1 — no farming by replay).
--   * Age-based per-user cap (per rolling 24h): brand-new accounts (<24h) still
--     count, but only the standard 1st + 2nd stream (cap 2); accounts older than
--     24h earn one extra (cap 3). Account age is server-truth (unspoofable), so
--     mass throwaway alts are limited to 2 each. The client credits up to 3 by
--     cumulative listen time; the server is the authoritative ceiling.
--   * Per-device cap: max 4 per device per track per 24h, so one physical device
--     can't farm a post through many accounts (the client sends a device id).
-- An eligible call inserts a `streams` row, which trips bump_stream_count.
-- (Requires streams_dedup.sql to have been run first.)

-- A stable per-install device id is logged with each stream so one physical
-- device can't farm a post through many accounts.
alter table public.streams add column if not exists device_id text;
create index if not exists streams_device_post_idx on public.streams (device_id, post_id, created_at);

-- The signature changed (added p_device_id), so drop the old single-arg version
-- to avoid an ambiguous overload.
drop function if exists public.record_stream(uuid);

create or replace function public.record_stream(p_post_id uuid, p_device_id text default null)
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

  -- Self-streams: the owner listening to their OWN track earns exactly ONE
  -- stream, EVER (no more than 1). Checked all-time (not the rolling 24h window),
  -- and this row is never purged below, so it's a hard lifetime cap of 1 — a
  -- creator can't pad their own count by replaying day after day.
  if v_owner = auth.uid() then
    if exists (
      select 1 from public.streams
      where user_id = auth.uid() and post_id = p_post_id
    ) then
      return;
    end if;
    insert into public.streams (user_id, post_id, device_id)
    values (auth.uid(), p_post_id, p_device_id);
    return;
  end if;

  -- Age-based per-user cap: new accounts (<24h) still earn the standard 1st + 2nd
  -- stream (cap 2); accounts older than 24h earn one extra (cap 3). Account age is
  -- server-truth (unspoofable). Tune the interval / caps below.
  select created_at into v_created from auth.users where id = auth.uid();
  if v_created is not null and now() - v_created >= interval '24 hours' then
    v_cap := 3;   -- established account: 2 + 1 extra
  else
    v_cap := 2;   -- new account: standard 1st + 2nd
  end if;
  -- Optional: if your project requires email confirmation, gate on it too:
  -- if not exists (select 1 from auth.users where id = auth.uid() and email_confirmed_at is not null) then return; end if;

  -- Drop this user's expired rows for the post so the table stays small and the
  -- counts below stay fast. stream_count is bumped only on INSERT (never on
  -- delete), so purging old rows never changes the public total.
  delete from public.streams
  where user_id = auth.uid() and post_id = p_post_id
    and created_at < now() - interval '24 hours';

  -- Per-user cap (age-based: 2 for new accounts, 3 for accounts older than 24h).
  select count(*) into v_recent
  from public.streams
  where user_id = auth.uid()
    and post_id = p_post_id
    and created_at > now() - interval '24 hours';
  if v_recent >= v_cap then return; end if;

  -- Per-device cap: one device credits at most 4 streams to a post per 24h,
  -- no matter how many accounts sign in on it.
  if p_device_id is not null then
    select count(*) into v_dev
    from public.streams
    where device_id = p_device_id
      and post_id = p_post_id
      and created_at > now() - interval '24 hours';
    if v_dev >= 4 then return; end if;
  end if;

  insert into public.streams (user_id, post_id, device_id) values (auth.uid(), p_post_id, p_device_id);
end;
$$;

grant execute on function public.record_stream(uuid, text) to authenticated;
