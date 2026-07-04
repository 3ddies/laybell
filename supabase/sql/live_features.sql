-- Live features — two systems that live side by side:
--
--  1) LIVESTREAMS (public broadcast) — Cloudflare Stream Live. A live_streams row
--     is the public card in the Live tab; the broadcast credentials (WHIP url /
--     RTMP key) live in live_stream_keys, readable ONLY by the broadcaster.
--     Phone go-live publishes WebRTC (WHIP) and viewers watch WHEP (sub-second);
--     OBS/encoder go-live publishes RTMP and viewers watch the HLS manifest.
--
--  2) STUDIO SESSIONS (private voice rooms) — LiveKit rooms for high-quality,
--     realtime collaboration. Membership gates the LiveKit token mint (see the
--     livekit-token edge function). Joining is by 6-char code via a SECURITY
--     DEFINER RPC so the session row itself can stay hidden from non-members.
--
-- Run manually in the Supabase Dashboard → SQL Editor.

create extension if not exists pgcrypto; -- gen_random_uuid()

-- 1) Livestreams -------------------------------------------------------------------

create table if not exists public.live_streams (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  -- 'webrtc' = phone go-live (WHIP publish, WHEP playback)
  -- 'rtmp'   = external encoder (RTMP publish, HLS playback, auto-recorded)
  mode text not null default 'webrtc' check (mode in ('webrtc', 'rtmp')),
  cf_input_uid text not null,
  -- What viewers open: WHEP play url for webrtc mode, HLS manifest for rtmp mode.
  playback_url text not null,
  status text not null default 'idle' check (status in ('idle', 'live', 'ended')),
  started_at timestamptz,
  ended_at timestamptz,
  viewer_peak int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists live_streams_live_idx on public.live_streams(status, started_at desc);
create index if not exists live_streams_user_idx on public.live_streams(user_id, created_at desc);

-- Broadcast secrets: NEVER readable by anyone but the broadcaster. Kept out of
-- live_streams so the public select policy can't leak them.
create table if not exists public.live_stream_keys (
  stream_id uuid primary key references public.live_streams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  whip_url text,
  rtmps_url text,
  rtmps_stream_key text,
  created_at timestamptz not null default now()
);

alter table public.live_streams enable row level security;
alter table public.live_stream_keys enable row level security;

-- Everyone can browse streams that are currently live; broadcasters also see
-- their own rows in any status (so Go Live can resume/end an idle input).
drop policy if exists "Live streams are public while live" on public.live_streams;
create policy "Live streams are public while live" on public.live_streams for select
  using (status = 'live' or user_id = auth.uid());
drop policy if exists "Users can create their streams" on public.live_streams;
create policy "Users can create their streams" on public.live_streams for insert
  with check (auth.uid() = user_id);
drop policy if exists "Broadcasters can update their streams" on public.live_streams;
create policy "Broadcasters can update their streams" on public.live_streams for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Broadcasters can delete their streams" on public.live_streams;
create policy "Broadcasters can delete their streams" on public.live_streams for delete
  using (auth.uid() = user_id);

drop policy if exists "Owner only stream keys" on public.live_stream_keys;
create policy "Owner only stream keys" on public.live_stream_keys for select
  using (auth.uid() = user_id);
drop policy if exists "Owner only stream key insert" on public.live_stream_keys;
create policy "Owner only stream key insert" on public.live_stream_keys for insert
  with check (auth.uid() = user_id);
drop policy if exists "Owner only stream key delete" on public.live_stream_keys;
create policy "Owner only stream key delete" on public.live_stream_keys for delete
  using (auth.uid() = user_id);

-- 2) Studio sessions ----------------------------------------------------------------

create table if not exists public.studio_sessions (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references auth.users(id) on delete cascade,
  title text,
  -- Shareable 6-char join code (uppercase, unambiguous-ish). Regenerated never;
  -- ending the session is what invalidates it.
  join_code text not null unique default upper(encode(gen_random_bytes(4), 'hex')),
  status text not null default 'open' check (status in ('open', 'ended')),
  created_at timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists studio_sessions_host_idx on public.studio_sessions(host_id, created_at desc);

create table if not exists public.studio_session_members (
  session_id uuid not null references public.studio_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('host', 'member')),
  joined_at timestamptz not null default now(),
  primary key (session_id, user_id)
);
create index if not exists studio_session_members_user_idx on public.studio_session_members(user_id);

-- Membership check as SECURITY DEFINER: same recursion-avoidance trick as
-- is_conversation_member in group_chats.sql.
create or replace function public.is_studio_member(sess uuid, uid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.studio_session_members m
    where m.session_id = sess and m.user_id = uid
  );
$$;

alter table public.studio_sessions enable row level security;
alter table public.studio_session_members enable row level security;

-- Sessions: members + host see them (host explicitly, so INSERT ... RETURNING
-- works before the host's membership row lands); anyone may host one; only the
-- host may rename/end it.
drop policy if exists "Members can view studio sessions" on public.studio_sessions;
create policy "Members can view studio sessions" on public.studio_sessions for select
  using (public.is_studio_member(id, auth.uid()) or host_id = auth.uid());
drop policy if exists "Users can host studio sessions" on public.studio_sessions;
create policy "Users can host studio sessions" on public.studio_sessions for insert
  with check (auth.uid() = host_id);
drop policy if exists "Host can update studio sessions" on public.studio_sessions;
create policy "Host can update studio sessions" on public.studio_sessions for update
  using (auth.uid() = host_id) with check (auth.uid() = host_id);
drop policy if exists "Host can delete studio sessions" on public.studio_sessions;
create policy "Host can delete studio sessions" on public.studio_sessions for delete
  using (auth.uid() = host_id);

-- Members: roster visible to members; the host may add people directly (invites);
-- you may remove yourself (leave); the host may remove anyone.
drop policy if exists "Members can view studio roster" on public.studio_session_members;
create policy "Members can view studio roster" on public.studio_session_members for select
  using (public.is_studio_member(session_id, auth.uid()));
drop policy if exists "Host can add studio members" on public.studio_session_members;
create policy "Host can add studio members" on public.studio_session_members for insert
  with check (
    exists (select 1 from public.studio_sessions s where s.id = session_id and s.host_id = auth.uid())
  );
drop policy if exists "Members can leave studio sessions" on public.studio_session_members;
create policy "Members can leave studio sessions" on public.studio_session_members for delete
  using (
    auth.uid() = user_id
    or exists (select 1 from public.studio_sessions s where s.id = session_id and s.host_id = auth.uid())
  );

-- Join by code: SECURITY DEFINER so a non-member can redeem a code without being
-- able to browse sessions. Only open sessions are joinable; capped at 12 seats
-- (a studio session, not an audience). Returns the session id.
create or replace function public.join_studio_session(code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  sess public.studio_sessions%rowtype;
  seats int;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  select * into sess from public.studio_sessions
    where join_code = upper(trim(code)) and status = 'open';
  if sess.id is null then
    raise exception 'invalid or ended session code';
  end if;
  select count(*) into seats from public.studio_session_members where session_id = sess.id;
  if seats >= 12 and not exists (
    select 1 from public.studio_session_members
    where session_id = sess.id and user_id = auth.uid()
  ) then
    raise exception 'session is full';
  end if;
  insert into public.studio_session_members(session_id, user_id, role)
    values (sess.id, auth.uid(), case when sess.host_id = auth.uid() then 'host' else 'member' end)
    on conflict (session_id, user_id) do nothing;
  return sess.id;
end; $$;

-- 3) Realtime — emit full rows so deletes carry their keys.
alter table public.live_streams replica identity full;
alter table public.studio_sessions replica identity full;
alter table public.studio_session_members replica identity full;
