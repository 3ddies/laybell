-- Anti-spam stream recording — Supabase
-- Run in the Supabase Dashboard → SQL Editor.
--
-- Replaces the direct `streams` insert from the client with a gatekept RPC so the
-- rules are enforced server-side (a client can't bypass them):
--   * No self-streams: the post owner listening to their own track never counts.
--   * Account-age gate: streams from accounts younger than 24h don't count, which
--     blunts mass-created throwaway alts. Account age is server-truth (unspoofable).
--   * Per-user cap: max 2 counted streams per user per track per rolling 24h. The
--     client only ever credits a 1st and 2nd stream (by cumulative listen time),
--     so 2 is the authoritative ceiling — closes "force-quit and replay" farming.
--   * Per-device cap: max 3 per device per track per 24h, so one physical device
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
begin
  if auth.uid() is null then return; end if;

  select user_id into v_owner from public.posts where id = p_post_id;
  if v_owner is null then return; end if;
  if v_owner = auth.uid() then return; end if;            -- no self-streams

  -- Anti-fraud: streams from very new accounts don't count (blunts mass alts).
  -- Tune the interval below; set to '0 hours' to disable. Unspoofable by clients.
  select created_at into v_created from auth.users where id = auth.uid();
  if v_created is null or now() - v_created < interval '24 hours' then return; end if;
  -- Optional: if your project requires email confirmation, also gate on it:
  -- if not exists (select 1 from auth.users where id = auth.uid() and email_confirmed_at is not null) then return; end if;

  -- Drop this user's expired rows for the post so the table stays small and the
  -- counts below stay fast. stream_count is bumped only on INSERT (never on
  -- delete), so purging old rows never changes the public total.
  delete from public.streams
  where user_id = auth.uid() and post_id = p_post_id
    and created_at < now() - interval '24 hours';

  -- Per-user cap: only ever the 1st + 2nd stream per rolling 24h.
  select count(*) into v_recent
  from public.streams
  where user_id = auth.uid()
    and post_id = p_post_id
    and created_at > now() - interval '24 hours';
  if v_recent >= 2 then return; end if;

  -- Per-device cap: one device credits at most 3 streams to a post per 24h,
  -- no matter how many accounts sign in on it.
  if p_device_id is not null then
    select count(*) into v_dev
    from public.streams
    where device_id = p_device_id
      and post_id = p_post_id
      and created_at > now() - interval '24 hours';
    if v_dev >= 3 then return; end if;
  end if;

  insert into public.streams (user_id, post_id, device_id) values (auth.uid(), p_post_id, p_device_id);
end;
$$;

grant execute on function public.record_stream(uuid, text) to authenticated;
