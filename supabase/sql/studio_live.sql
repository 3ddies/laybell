-- Studio live broadcasts — a studio session can be broadcast to a listener
-- audience ("modern radio"): listeners tune in (subscribe-only LiveKit),
-- comment + donate over the audience channel, and can REQUEST TO JOIN the
-- session itself. Run AFTER live_features.sql and donations.sql.
--
-- Design notes:
--   * Discovery is RPC-ONLY (fetch_live_studio_sessions / fetch_studio_listen).
--     There is deliberately NO public SELECT policy on studio_sessions: the
--     join_code column is the room credential and must stay members-only.
--   * Join requests are written exclusively through SECURITY DEFINER RPCs so
--     the seat cap + host checks can't be bypassed; RLS on the table is
--     read-only (it exists for realtime + polling).
--   * Donations grow a second, mutually-exclusive target: studio_session_id.
--     donation_guard v3 resolves the host from whichever target is set.

do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'studio_sessions') then
    raise exception 'Run live_features.sql before studio_live.sql (public.studio_sessions is missing).';
  end if;
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'donations') then
    raise exception 'Run donations.sql before studio_live.sql (public.donations is missing).';
  end if;
end $$;

-- ── 1. Broadcast state on the session ─────────────────────────────────────────

alter table public.studio_sessions add column if not exists live boolean not null default false;
alter table public.studio_sessions add column if not exists live_started_at timestamptz;
alter table public.studio_sessions add column if not exists listener_peak integer not null default 0;

-- ── 2. Join requests (listener → session member) ──────────────────────────────

create table if not exists public.studio_join_requests (
  session_id uuid not null references public.studio_sessions(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  status     text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  primary key (session_id, user_id)
);

alter table public.studio_join_requests enable row level security;

-- Requester sees their own request; the host sees all of their session's.
drop policy if exists "Own or hosted join requests" on public.studio_join_requests;
create policy "Own or hosted join requests" on public.studio_join_requests for select
  using (
    auth.uid() = user_id
    or exists (select 1 from public.studio_sessions s
               where s.id = session_id and s.host_id = auth.uid())
  );

-- A requester may withdraw their own pending request. All other writes happen
-- through the RPCs below (security definer), never directly.
drop policy if exists "Withdraw own join request" on public.studio_join_requests;
create policy "Withdraw own join request" on public.studio_join_requests for delete
  using (auth.uid() = user_id and status = 'pending');

alter table public.studio_join_requests replica identity full;

-- Listener asks to join a LIVE session. Returns the request's current status
-- ('pending' | 'accepted' | 'declined' | 'member' when already in).
create or replace function public.request_studio_join(p_session uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
begin
  if v_uid is null then
    raise exception 'not_signed_in';
  end if;
  if not exists (select 1 from studio_sessions
                 where id = p_session and status = 'open' and live) then
    raise exception 'not_live';
  end if;
  if exists (select 1 from studio_session_members
             where session_id = p_session and user_id = v_uid) then
    return 'member';
  end if;

  insert into studio_join_requests (session_id, user_id)
  values (p_session, v_uid)
  on conflict (session_id, user_id) do nothing;

  select status into v_status from studio_join_requests
  where session_id = p_session and user_id = v_uid;
  return coalesce(v_status, 'pending');
end; $$;
grant execute on function public.request_studio_join(uuid) to authenticated;

-- Host accepts/declines. Accepting seats the user (honoring the 12-seat cap,
-- same limit as join_studio_session).
create or replace function public.respond_studio_join(p_session uuid, p_user uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_seats int;
begin
  if v_uid is null or not exists (select 1 from studio_sessions
                                  where id = p_session and host_id = v_uid) then
    raise exception 'not_host';
  end if;

  if p_accept then
    select count(*) into v_seats from studio_session_members where session_id = p_session;
    if v_seats >= 12 then
      raise exception 'session_full';
    end if;
    insert into studio_session_members (session_id, user_id, role)
    values (p_session, p_user, 'member')
    on conflict do nothing;
  end if;

  update studio_join_requests
  set status = case when p_accept then 'accepted' else 'declined' end
  where session_id = p_session and user_id = p_user;
end; $$;
grant execute on function public.respond_studio_join(uuid, uuid, boolean) to authenticated;

-- ── 3. RPC-only discovery (safe columns — join_code NEVER leaves) ─────────────

create or replace function public.fetch_live_studio_sessions()
returns table (
  id uuid, title text, host_id uuid, live_started_at timestamptz,
  host_username text, host_display_name text, host_avatar_url text,
  member_count bigint
) language sql stable security definer set search_path = public as $$
  select s.id, s.title, s.host_id, s.live_started_at,
         p.username, p.display_name, p.avatar_url,
         (select count(*) from studio_session_members m where m.session_id = s.id)
  from studio_sessions s
  join profiles p on p.id = s.host_id
  where s.status = 'open' and s.live
  order by s.live_started_at desc nulls last
  limit 50;
$$;
grant execute on function public.fetch_live_studio_sessions() to authenticated;

-- Everything the listen screen needs in one call; null once the broadcast ends
-- (the listener screen treats null as "ended").
create or replace function public.fetch_studio_listen(p_session uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not exists (
    select 1 from studio_sessions where id = p_session and status = 'open' and live
  ) then null else jsonb_build_object(
    'session', (
      select jsonb_build_object(
        'id', s.id, 'title', s.title, 'host_id', s.host_id,
        'live_started_at', s.live_started_at)
      from studio_sessions s where s.id = p_session
    ),
    'roster', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'user_id', m.user_id, 'role', m.role,
        'username', p.username, 'display_name', p.display_name,
        'avatar_url', p.avatar_url)), '[]'::jsonb)
      from studio_session_members m
      join profiles p on p.id = m.user_id
      where m.session_id = p_session
    )
  ) end;
$$;
grant execute on function public.fetch_studio_listen(uuid) to authenticated;

-- ── 4. Donations can target a studio broadcast ────────────────────────────────

alter table public.donations alter column stream_id drop not null;
alter table public.donations add column if not exists studio_session_id uuid references public.studio_sessions(id) on delete cascade;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'donations_one_target') then
    alter table public.donations add constraint donations_one_target
      check ((stream_id is null) <> (studio_session_id is null));
  end if;
end $$;

create index if not exists donations_studio_idx on public.donations (studio_session_id, created_at desc);

-- donation_guard v3: resolve the host from the live stream OR the studio
-- session. Same tiered fee ("Earn More": 8% Premium / 35% standard), tax on
-- top, 200-char message clamp — rates mirror lib/donations.
create or replace function public.donation_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_host uuid;
begin
  if new.stream_id is not null then
    select user_id into v_host from public.live_streams where id = new.stream_id;
  elsif new.studio_session_id is not null then
    select host_id into v_host from public.studio_sessions where id = new.studio_session_id;
  end if;
  if v_host is null then
    raise exception 'stream_not_found';
  end if;
  new.streamer_id := v_host;

  if new.donor_id = v_host then
    raise exception 'cannot_donate_to_self';
  end if;

  new.laybell_fee_cents     := round(new.amount_cents * (case when public.is_premium(v_host) then 0.08 else 0.35 end));
  new.tax_cents             := round(new.amount_cents * 0.06);
  new.streamer_payout_cents := new.amount_cents - new.laybell_fee_cents;
  new.provider              := coalesce(new.provider, 'simulated');
  new.status                := coalesce(new.status, 'succeeded');
  new.processed_at          := now();
  new.message               := nullif(left(trim(coalesce(new.message, '')), 200), '');
  return new;
end; $$;
