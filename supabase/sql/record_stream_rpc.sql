-- Anti-spam stream recording — Supabase
-- Run in the Supabase Dashboard → SQL Editor.
--
-- Replaces the direct `streams` insert from the client with a gatekept RPC so the
-- rules are enforced server-side (a client can't bypass them):
--   * No self-streams: the post owner listening to their own track never counts.
--   * Max 10 counted streams per user per track per rolling 24h (anti-monopoly).
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

  select count(*) into v_recent
  from public.streams
  where user_id = auth.uid()
    and post_id = p_post_id
    and created_at > now() - interval '24 hours';
  if v_recent >= 10 then return; end if;                  -- 24h per-user cap

  insert into public.streams (user_id, post_id) values (auth.uid(), p_post_id);
end;
$$;

grant execute on function public.record_stream(uuid) to authenticated;
