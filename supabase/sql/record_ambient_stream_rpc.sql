-- Ambient (post-attached) stream recording — Supabase
-- Run in the Supabase Dashboard → SQL Editor (after streams_dedup.sql +
-- record_stream_rpc.sql).
--
-- A SEPARATE stream ecosystem from record_stream, for songs ATTACHED to image/
-- video/slideshow/story posts that auto-play ambiently as you scroll. Because that
-- listening is often unintentional, the rules are deliberately different and the
-- accounting is independent of the regular `streams` table:
--   * Flat 30s of genuine, unmuted listening (cumulative across every post/story
--     that uses the song) earns exactly ONE stream — credited by the client.
--   * Per-user cap: at most 1 ambient stream per song per rolling 24h.
--   * No self-streams: the song's owner never earns from their own track.
--   * Per-device cap: limits one physical device farming a song through many alts.
-- Ambient streams STACK on top of regular ones: they live in their own table with
-- their own trigger, so a listener who also taps the song still earns the normal
-- up-to-3 via record_stream (total up to 4). Tune the caps/interval below.

create table if not exists public.ambient_streams (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  song_id    uuid not null references public.posts(id) on delete cascade,
  device_id  text,
  created_at timestamptz not null default now()
);

create index if not exists ambient_streams_user_song_idx   on public.ambient_streams (user_id, song_id, created_at);
create index if not exists ambient_streams_device_song_idx on public.ambient_streams (device_id, song_id, created_at);

alter table public.ambient_streams enable row level security;

-- Clients only ever write through the (security definer) RPC below, but keep RLS
-- tight for any direct access: a user can read/insert only their own rows.
drop policy if exists "Users read own ambient streams" on public.ambient_streams;
create policy "Users read own ambient streams"
on public.ambient_streams for select using (auth.uid() = user_id);

drop policy if exists "Users insert own ambient streams" on public.ambient_streams;
create policy "Users insert own ambient streams"
on public.ambient_streams for insert with check (auth.uid() = user_id);

-- Each ambient stream bumps the same public posts.stream_count as a regular one,
-- so the two ecosystems sum into the song's total (ambient stacks on top).
create or replace function public.bump_ambient_stream_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.posts set stream_count = stream_count + 1 where id = new.song_id;
  return null;
end;
$$;

drop trigger if exists trg_bump_ambient_stream_count on public.ambient_streams;
create trigger trg_bump_ambient_stream_count
after insert on public.ambient_streams
for each row execute function public.bump_ambient_stream_count();

-- Gatekept RPC: the client calls this once it has accrued 30s of genuine unmuted
-- ambient listening for a song. The server is the authoritative ceiling.
create or replace function public.record_ambient_stream(p_song_id uuid, p_device_id text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner  uuid;
  v_recent int;
  v_dev    int;
begin
  if auth.uid() is null then return; end if;

  select user_id into v_owner from public.posts where id = p_song_id;
  if v_owner is null then return; end if;            -- song/post gone
  if v_owner = auth.uid() then return; end if;       -- no self-streams

  -- Purge this user's expired rows for the song (keeps the table small; the bump
  -- trigger fires only on INSERT, so deleting old rows never lowers the total).
  delete from public.ambient_streams
  where user_id = auth.uid() and song_id = p_song_id
    and created_at < now() - interval '24 hours';

  -- Per-user cap: at most 1 ambient stream per song per rolling 24h.
  select count(*) into v_recent
  from public.ambient_streams
  where user_id = auth.uid() and song_id = p_song_id
    and created_at > now() - interval '24 hours';
  if v_recent >= 1 then return; end if;

  -- Per-device cap: one physical device earns at most 2 ambient streams for a song
  -- per 24h, no matter how many accounts sign in on it (limits alt-farming).
  if p_device_id is not null then
    select count(*) into v_dev
    from public.ambient_streams
    where device_id = p_device_id and song_id = p_song_id
      and created_at > now() - interval '24 hours';
    if v_dev >= 2 then return; end if;
  end if;

  insert into public.ambient_streams (user_id, song_id, device_id)
  values (auth.uid(), p_song_id, p_device_id);
end;
$$;

grant execute on function public.record_ambient_stream(uuid, text) to authenticated;
