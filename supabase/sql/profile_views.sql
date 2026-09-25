-- Profile views — "who viewed your profile" (owner, 2026-09-24), TikTok-style but
-- OPT-OUT (on by default, owner's call) and RECIPROCAL. You only get recorded /
-- appear in anyone's list while YOU have profile_views_enabled on, and you only
-- see your own list while you have it on. 30-day window at display. Writes go
-- through a definer RPC; a user can turn it off in the Profile views screen.

-- 1. The flag — ON by default (owner 2026-09-24: opt-OUT, not opt-in). The
-- add-if-not-exists seeds a fresh DB; the explicit set-default + backfill flip an
-- existing column (first shipped default false) and opt current accounts in. Still
-- reciprocal: both people must have it on for a view to be recorded / to appear.
alter table public.profiles
  add column if not exists profile_views_enabled boolean not null default true;
alter table public.profiles alter column profile_views_enabled set default true;
update public.profiles set profile_views_enabled = true where not profile_views_enabled;

-- 2. One row per (owner, viewer); viewed_at updates on re-view (most-recent wins).
create table if not exists public.profile_views (
  owner_id   uuid not null references public.profiles(id) on delete cascade,
  viewer_id  uuid not null references public.profiles(id) on delete cascade,
  viewed_at  timestamptz not null default now(),
  primary key (owner_id, viewer_id)
);
create index if not exists profile_views_owner_time_idx
  on public.profile_views (owner_id, viewed_at desc);

alter table public.profile_views enable row level security;

-- The owner may read their own viewer rows; nobody reads anyone else's. All
-- writes go through the definer RPCs below, never the client directly.
drop policy if exists profile_views_owner_read on public.profile_views;
create policy profile_views_owner_read on public.profile_views
  for select using (owner_id = auth.uid());

-- 3. Record a view. Only when the VIEWER has opted in (so keeping the setting off
-- means you never appear anywhere). Never records self.
create or replace function public.record_profile_view(target uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if target is null or auth.uid() is null or target = auth.uid() then
    return;
  end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and profile_views_enabled) then
    return;
  end if;
  -- The owner must be opted in too, so an opted-out owner collects nothing and
  -- receives no realtime "viewed you" events (reciprocity; matches the list RPC).
  if not exists (select 1 from public.profiles where id = target and profile_views_enabled) then
    return;
  end if;
  if exists (
    select 1 from public.blocks
    where (blocker_id = auth.uid() and blocked_id = target)
       or (blocker_id = target and blocked_id = auth.uid())
  ) then
    return;
  end if;
  insert into public.profile_views (owner_id, viewer_id, viewed_at)
  values (target, auth.uid(), now())
  on conflict (owner_id, viewer_id) do update set viewed_at = excluded.viewed_at;
end;
$$;

-- 4. The owner's viewer list — only while THEY are opted in — last 30 days,
-- newest first, hiding hidden viewers, viewers who've since opted out, and blocks.
create or replace function public.get_profile_viewers(max_rows int default 100)
returns table (
  viewer_id uuid, username text, display_name text, avatar_url text,
  badge_tier text, badge_show boolean, viewed_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then return; end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and profile_views_enabled) then
    return;
  end if;
  return query
    select pv.viewer_id, p.username, p.display_name, p.avatar_url,
           p.badge_tier, p.badge_show, pv.viewed_at
    from public.profile_views pv
    join public.profiles p on p.id = pv.viewer_id
    where pv.owner_id = auth.uid()
      and pv.viewed_at > now() - interval '30 days'
      and coalesce(p.hidden, false) = false
      and p.profile_views_enabled = true
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = auth.uid() and b.blocked_id = pv.viewer_id)
           or (b.blocker_id = pv.viewer_id and b.blocked_id = auth.uid())
      )
    order by pv.viewed_at desc
    limit greatest(1, least(max_rows, 500));
end;
$$;

-- 5. A cheap count for the eye-icon badge (same gates as the list).
create or replace function public.get_profile_viewers_count()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  if auth.uid() is null then return 0; end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and profile_views_enabled) then
    return 0;
  end if;
  select count(*) into n
  from public.profile_views pv
  join public.profiles p on p.id = pv.viewer_id
  where pv.owner_id = auth.uid()
    and pv.viewed_at > now() - interval '30 days'
    and coalesce(p.hidden, false) = false
    and p.profile_views_enabled = true
    and not exists (
      select 1 from public.blocks b
      where (b.blocker_id = auth.uid() and b.blocked_id = pv.viewer_id)
         or (b.blocker_id = pv.viewer_id and b.blocked_id = auth.uid())
    );
  return coalesce(n, 0);
end;
$$;

-- 6. Turn OFF → purge your outgoing views, so opting out removes you everywhere
-- (belt-and-suspenders with the display-time enabled filter).
create or replace function public.clear_my_profile_views()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then return; end if;
  delete from public.profile_views where viewer_id = auth.uid();
end;
$$;

-- Lock the RPCs to authenticated only, never anon (supabase-sql-runner rule).
revoke all on function public.record_profile_view(uuid) from public;
revoke all on function public.record_profile_view(uuid) from anon;
revoke all on function public.get_profile_viewers(int) from public;
revoke all on function public.get_profile_viewers(int) from anon;
revoke all on function public.get_profile_viewers_count() from public;
revoke all on function public.get_profile_viewers_count() from anon;
revoke all on function public.clear_my_profile_views() from public;
revoke all on function public.clear_my_profile_views() from anon;
grant execute on function public.record_profile_view(uuid) to authenticated;
grant execute on function public.get_profile_viewers(int) to authenticated;
grant execute on function public.get_profile_viewers_count() to authenticated;
grant execute on function public.clear_my_profile_views() to authenticated;

-- 7. Realtime: deliver a live "viewed your profile" event to the owner so the app
-- can pop an in-app banner (ActivityBanner). RLS (owner-read) scopes delivery to
-- the owner; FULL replica identity lets RLS evaluate UPDATE events (a re-view
-- bumps viewed_at). Guarded publication add — a table can exist and publish
-- nothing (realtime-publication-gap), so this is the part that actually matters.
alter table public.profile_views replica identity full;
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'profile_views'
  ) then
    alter publication supabase_realtime add table public.profile_views;
  end if;
end $$;
