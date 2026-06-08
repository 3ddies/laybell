-- Anti-spam stream recording — Supabase
-- Run in the Supabase Dashboard → SQL Editor.
--
-- Replaces the direct `streams` insert from the client with a gatekept RPC so the
-- rules are enforced server-side (a client can't bypass them):
--   * No self-streams: the post owner listening to their own track never counts.
--   * Max 2 counted streams per user per track per rolling 24h. The client only
--     ever credits a 1st and 2nd stream (by cumulative listen time), so 2 is the
--     authoritative ceiling — this closes any "force-quit and replay" farming,
--     since the client's in-memory progress reset can't beat the server cap.
-- An eligible call inserts a `streams` row, which trips bump_stream_count.
-- (Requires streams_dedup.sql to have been run first.)

create or replace function public.record_stream(p_post_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_recent int;
begin
  if auth.uid() is null then return; end if;

  select user_id into v_owner from public.posts where id = p_post_id;
  if v_owner is null then return; end if;
  if v_owner = auth.uid() then return; end if;            -- no self-streams

  -- Drop this user's expired rows for the post so the table stays small and the
  -- count below stays fast. stream_count is bumped only on INSERT (never on
  -- delete), so purging old rows never changes the public total.
  delete from public.streams
  where user_id = auth.uid() and post_id = p_post_id
    and created_at < now() - interval '24 hours';

  select count(*) into v_recent
  from public.streams
  where user_id = auth.uid()
    and post_id = p_post_id
    and created_at > now() - interval '24 hours';
  if v_recent >= 2 then return; end if;                   -- 1st + 2nd stream only, per 24h

  insert into public.streams (user_id, post_id) values (auth.uid(), p_post_id);
end;
$$;

grant execute on function public.record_stream(uuid) to authenticated;
