-- Communities + community hashtags — Supabase tables, RLS, RPCs, triggers
-- Run in the Supabase Dashboard → SQL Editor (the anon key cannot create tables
-- or policies). Until this is applied, the Communities button opens an empty
-- discovery screen, the post composer's "Community" picker shows the locked
-- empty state, and every RPC below rejects — the app keeps working either way
-- (lib/communities.ts catches the missing-table/RPC errors and degrades).
--
-- ── Model ───────────────────────────────────────────────────────────────────
-- A community is a genre-scoped, user-made space that owns ONE custom hashtag.
-- Active members can attach the hashtag to a post (posts.community_id) so it
-- appears in the community's grid; anyone can VIEW that grid.
--
-- Gating (badge tiers, see lib/badges.ts):
--   • Diamond badge → create a community (becomes its owner)
--   • Gold badge    → can be appointed a manager
--   • everyone      → join / post-to / view
-- Tier is enforced ONLY at appointment time: losing Diamond/Gold later keeps the
-- role (the person was already chosen for it).
--
-- Lifecycle: a new community is created `pending` (established but private — only
-- its members can see it). It latches to `live` (publicly discoverable + postable)
-- the moment it has >= 7 active members INCLUDING at least one active manager.
-- Once live it stays live; it `archived`s only if it loses every member.
--
-- Roles & moderation (direct; the vote-to-ban governance is a later phase):
--   • owner   — absolute say: promote/demote anyone, ban, mute, transfer ownership
--   • manager — moderate MEMBERS only: ban / mute / remove, invite members
--   • member  — join, post, view
-- All writes go through the SECURITY DEFINER rpcs below (which enforce the rules
-- server-side); RLS only governs reads.

-- ── Tables ──────────────────────────────────────────────────────────────────

create table if not exists public.communities (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  hashtag       text not null,          -- postable tag token, e.g. 'rapaddicts'
  genre         text not null,          -- one of the 16 canonical genres (lowercase)
  guidelines    text,
  banner_url    text,                   -- owner-set banner image (else a generated gradient)
  owner_id      uuid references auth.users(id) on delete set null,
  status        text not null default 'pending' check (status in ('pending','live','archived')),
  member_count  integer not null default 1,
  post_count    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Idempotent column backfill: if a `communities` table already existed (e.g. an
-- earlier/partial run or an experiment), the `create table if not exists` above is
-- a no-op, so add any missing columns before the indexes/rpcs reference them.
alter table public.communities add column if not exists name         text;
alter table public.communities add column if not exists hashtag      text;
alter table public.communities add column if not exists genre        text;
alter table public.communities add column if not exists guidelines   text;
alter table public.communities add column if not exists banner_url   text;
alter table public.communities add column if not exists owner_id     uuid references auth.users(id) on delete set null;
alter table public.communities add column if not exists status       text not null default 'pending';
alter table public.communities add column if not exists member_count integer not null default 1;
alter table public.communities add column if not exists post_count   integer not null default 0;
alter table public.communities add column if not exists created_at   timestamptz not null default now();
alter table public.communities add column if not exists updated_at   timestamptz not null default now();

-- Names are unique case-insensitively (stops users copying another community's
-- identity); the hashtag token is unique too (it's the dropdown/postable key).
create unique index if not exists communities_name_key    on public.communities (lower(name));
create unique index if not exists communities_hashtag_key on public.communities (lower(hashtag));
create index        if not exists communities_genre_idx   on public.communities (genre);
create index        if not exists communities_status_idx  on public.communities (status);
create index        if not exists communities_owner_idx   on public.communities (owner_id);

create table if not exists public.community_members (
  community_id  uuid not null references public.communities(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  role          text not null default 'member' check (role in ('owner','manager','member')),
  status        text not null default 'active' check (status in ('invited','active','banned')),
  muted_until   timestamptz,            -- temporary posting ban (owner/manager)
  invited_by    uuid references auth.users(id) on delete set null,
  joined_at     timestamptz,
  created_at    timestamptz not null default now(),
  primary key (community_id, user_id)
);

-- Idempotent column backfill (see note above) for a pre-existing members table.
alter table public.community_members add column if not exists role        text not null default 'member';
alter table public.community_members add column if not exists status      text not null default 'active';
alter table public.community_members add column if not exists muted_until timestamptz;
alter table public.community_members add column if not exists invited_by  uuid references auth.users(id) on delete set null;
alter table public.community_members add column if not exists joined_at   timestamptz;
alter table public.community_members add column if not exists created_at  timestamptz not null default now();

create index if not exists community_members_user_idx on public.community_members (user_id);
create index if not exists community_members_role_idx on public.community_members (community_id, role, status);

-- A post can belong to MULTIPLE communities. `community_ids` (uuid[]) is the
-- source of truth; `community_id`/`community_hashtag` stay as the FIRST one
-- (legacy single-pointer, kept for any old reads); `community_tags` is the
-- denormalized [{id,hashtag}] array the feed/viewers render — one tappable tag
-- per community. The post guard (below) validates membership across ALL chosen
-- communities and recomputes these on write. Genre rule: if every chosen
-- community shares one genre the post takes it; if they differ, the post is
-- 'no genre' (NULL) — a post can't be grouped under two genres at once.
alter table public.posts
  add column if not exists community_id uuid references public.communities(id) on delete set null;
alter table public.posts add column if not exists community_hashtag text;
alter table public.posts add column if not exists community_ids  uuid[] not null default '{}';
alter table public.posts add column if not exists community_tags jsonb  not null default '[]'::jsonb;
create index if not exists posts_community_idx     on public.posts (community_id);
create index if not exists posts_community_ids_idx on public.posts using gin (community_ids);

-- Backfill the array from the legacy single community_id. The `= '{}'` guard
-- makes this a no-op on re-runs (so it never re-fires the triggers below).
update public.posts
   set community_ids = array[community_id]
 where community_id is not null and community_ids = '{}';

-- Lightweight moderation audit trail (who did what to whom).
create table if not exists public.community_mod_log (
  id            uuid primary key default gen_random_uuid(),
  community_id  uuid not null references public.communities(id) on delete cascade,
  actor_id      uuid references auth.users(id) on delete set null,
  target_id     uuid references auth.users(id) on delete set null,
  action        text not null,         -- promote | demote | transfer | ban | unban | mute | unmute | remove | invite
  detail        text,
  created_at    timestamptz not null default now()
);
-- Idempotent column backfill (see note above) for a pre-existing mod-log table.
alter table public.community_mod_log add column if not exists actor_id   uuid references auth.users(id) on delete set null;
alter table public.community_mod_log add column if not exists target_id  uuid references auth.users(id) on delete set null;
alter table public.community_mod_log add column if not exists action     text;
alter table public.community_mod_log add column if not exists detail     text;
alter table public.community_mod_log add column if not exists created_at timestamptz not null default now();
create index if not exists community_mod_log_idx on public.community_mod_log (community_id, created_at desc);

-- ── Helper functions (SECURITY DEFINER so RLS policies that call them don't
--    recurse back through community_members' own policies) ────────────────────

create or replace function public.is_community_member(p_community uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.community_members
    where community_id = p_community and user_id = p_user and status = 'active'
  );
$$;

create or replace function public.community_is_live(p_community uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.communities where id = p_community and status = 'live');
$$;

-- ── Membership sync: keeps member_count current and LATCHES pending → live ────
-- Threshold to go live: >= 7 active members including >= 1 active manager.
create or replace function public.community_sync_membership()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_community uuid := coalesce(new.community_id, old.community_id);
  v_active    integer;
  v_managers  integer;
  v_status    text;
begin
  select count(*) filter (where status = 'active'),
         count(*) filter (where status = 'active' and role = 'manager')
    into v_active, v_managers
    from public.community_members
   where community_id = v_community;

  select status into v_status from public.communities where id = v_community;
  if not found then return null; end if;

  update public.communities set member_count = v_active, updated_at = now()
   where id = v_community;

  -- One-way latch to live once the bar is cleared (never demotes back to pending).
  if v_status = 'pending' and v_active >= 7 and v_managers >= 1 then
    update public.communities set status = 'live', updated_at = now() where id = v_community;
  end if;

  -- A community that has lost every member is archived (orphaned shell).
  if v_active = 0 and v_status <> 'archived' then
    update public.communities set status = 'archived', updated_at = now() where id = v_community;
  end if;

  return null;
end; $$;

drop trigger if exists trg_community_sync_membership on public.community_members;
create trigger trg_community_sync_membership
after insert or update or delete on public.community_members
for each row execute function public.community_sync_membership();

-- ── Recompute a post's denormalized community fields from community_ids ───────
-- Rebuilds community_tags (one {id,hashtag} per community), the legacy first
-- pointer (community_id/community_hashtag), and the genre (the shared genre if
-- all chosen communities agree, else NULL = 'no genre'). Does NOT validate
-- membership (that's the guard's job on write) — it's a pure denormalizer used
-- by the community hashtag/genre sync below.
create or replace function public.recompute_post_communities(p_post uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_ids uuid[]; v_tags jsonb; v_genres text[]; v_genre text; v_cid uuid; v_htag text;
begin
  select community_ids into v_ids from public.posts where id = p_post;
  if v_ids is null or array_length(v_ids, 1) is null then
    update public.posts set community_tags = '[]'::jsonb, community_id = null, community_hashtag = null where id = p_post;
    return;
  end if;
  select jsonb_agg(jsonb_build_object('id', c.id, 'hashtag', c.hashtag) order by arr.ord),
         array_agg(distinct c.genre)
    into v_tags, v_genres
    from unnest(v_ids) with ordinality as arr(cid, ord)
    join public.communities c on c.id = arr.cid;
  select c.id, c.hashtag into v_cid, v_htag
    from unnest(v_ids) with ordinality as arr(cid, ord)
    join public.communities c on c.id = arr.cid
    order by arr.ord limit 1;
  v_genre := case when array_length(v_genres, 1) = 1 then v_genres[1] else null end;
  update public.posts set
    community_tags    = coalesce(v_tags, '[]'::jsonb),
    community_id      = v_cid,
    community_hashtag = v_htag,
    genre             = v_genre
  where id = p_post;
end; $$;

-- ── Post guard: validate membership across EVERY chosen community + denormalize.
create or replace function public.community_post_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare cid uuid; mem record; v_tags jsonb; v_genres text[]; v_genre text; v_cid uuid; v_htag text;
begin
  if new.community_ids is null or array_length(new.community_ids, 1) is null then
    new.community_tags := '[]'::jsonb;
    new.community_id := null;
    new.community_hashtag := null;
    return new;
  end if;
  -- A community space is public; a community post can never be friends-only.
  if new.is_public is not true then
    raise exception 'community posts must be public';
  end if;
  -- A post can be tagged into at most 3 communities (matches MAX_POST_COMMUNITIES).
  if array_length(new.community_ids, 1) > 3 then
    raise exception 'a post can be in at most 3 communities';
  end if;
  -- The author must be an active, non-muted member of each LIVE community chosen.
  foreach cid in array new.community_ids loop
    select cm.status, cm.muted_until, c.status as cstatus
      into mem
      from public.community_members cm
      join public.communities c on c.id = cm.community_id
     where cm.community_id = cid and cm.user_id = new.user_id;
    if not found or mem.status <> 'active' then raise exception 'not a member of a chosen community'; end if;
    if mem.cstatus <> 'live' then raise exception 'a chosen community is not live yet'; end if;
    if mem.muted_until is not null and mem.muted_until > now() then raise exception 'posting is temporarily restricted in a chosen community'; end if;
  end loop;
  -- Denormalize: tags + legacy first pointer + genre (shared, else NULL).
  select jsonb_agg(jsonb_build_object('id', c.id, 'hashtag', c.hashtag) order by arr.ord),
         array_agg(distinct c.genre)
    into v_tags, v_genres
    from unnest(new.community_ids) with ordinality as arr(cid, ord)
    join public.communities c on c.id = arr.cid;
  select c.id, c.hashtag into v_cid, v_htag
    from unnest(new.community_ids) with ordinality as arr(cid, ord)
    join public.communities c on c.id = arr.cid order by arr.ord limit 1;
  v_genre := case when array_length(v_genres, 1) = 1 then v_genres[1] else null end;
  new.community_tags := coalesce(v_tags, '[]'::jsonb);
  new.community_id := v_cid;
  new.community_hashtag := v_htag;
  new.genre := v_genre;  -- one shared genre, or NULL ('no genre') when they differ
  return new;
end; $$;

drop trigger if exists trg_community_post_guard on public.posts;
create trigger trg_community_post_guard
before insert or update of community_ids, is_public on public.posts
for each row execute function public.community_post_guard();

-- ── Post-count sync: add/remove a post from each community it joins/leaves ────
create or replace function public.community_sync_post_count()
returns trigger language plpgsql security definer set search_path = public as $$
declare cid uuid; v_old uuid[] := coalesce(old.community_ids, '{}'); v_new uuid[] := coalesce(new.community_ids, '{}');
begin
  if tg_op = 'INSERT' then
    foreach cid in array v_new loop update public.communities set post_count = post_count + 1 where id = cid; end loop;
  elsif tg_op = 'DELETE' then
    foreach cid in array v_old loop update public.communities set post_count = greatest(post_count - 1, 0) where id = cid; end loop;
  elsif tg_op = 'UPDATE' then
    foreach cid in array v_old loop if not (cid = any(v_new)) then update public.communities set post_count = greatest(post_count - 1, 0) where id = cid; end if; end loop;
    foreach cid in array v_new loop if not (cid = any(v_old)) then update public.communities set post_count = post_count + 1 where id = cid; end if; end loop;
  end if;
  return null;
end; $$;

drop trigger if exists trg_community_sync_post_count on public.posts;
create trigger trg_community_sync_post_count
after insert or delete or update of community_ids on public.posts
for each row execute function public.community_sync_post_count();

-- ── Keep community posts in sync when a community's hashtag OR genre changes ──
-- (re-spells the tag and re-derives the shared/NULL genre for every post in it).
create or replace function public.community_sync_hashtag()
returns trigger language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if new.hashtag is distinct from old.hashtag or new.genre is distinct from old.genre then
    for r in select id from public.posts where new.id = any(community_ids) loop
      perform public.recompute_post_communities(r.id);
    end loop;
  end if;
  return null;
end; $$;

drop trigger if exists trg_community_sync_hashtag on public.communities;
create trigger trg_community_sync_hashtag
after update of hashtag, genre on public.communities
for each row execute function public.community_sync_hashtag();

-- Backfill the denormalized tags/genre for posts migrated from the single
-- community_id (only those not yet computed → no-op on re-runs). Touches
-- community_tags/genre, never community_ids, so it doesn't re-fire the triggers.
do $$ declare r record; begin
  for r in select id from public.posts where community_ids <> '{}' and community_tags = '[]'::jsonb loop
    perform public.recompute_post_communities(r.id);
  end loop;
end $$;

-- ── RLS ──────────────────────────────────────────────────────────────────────

alter table public.communities enable row level security;
alter table public.community_members enable row level security;
alter table public.community_mod_log enable row level security;

-- communities: live/archived are public; a pending community is visible only to
-- its own members (and its owner). Writes go through the rpcs (SECURITY DEFINER),
-- so no insert/update/delete policy is granted to direct client calls.
drop policy if exists "Communities are viewable" on public.communities;
create policy "Communities are viewable"
on public.communities for select
using (status <> 'pending' or public.is_community_member(id, auth.uid()) or owner_id = auth.uid());

-- community_members: anyone can see the ACTIVE roster of a LIVE community; a
-- member sees every row of their own community; everyone can see their OWN row
-- (so an invited user can find their pending invite).
drop policy if exists "Community members are viewable" on public.community_members;
create policy "Community members are viewable"
on public.community_members for select
using (
  (status = 'active' and public.community_is_live(community_id))
  or public.is_community_member(community_id, auth.uid())
  or user_id = auth.uid()
);

-- mod log: visible to the community's active members (owner/managers review it).
drop policy if exists "Community mod log is viewable by members" on public.community_mod_log;
create policy "Community mod log is viewable by members"
on public.community_mod_log for select
using (public.is_community_member(community_id, auth.uid()));

-- ── RPCs (all SECURITY DEFINER; auth.uid() is the caller) ─────────────────────

-- Create a community. Caller must hold the Diamond badge. `p_invites` is a JSON
-- array of { user_id, role } where role ∈ ('member','manager'); a 'manager'
-- invite whose target isn't Gold+ at this moment is silently downgraded to
-- 'member'. Returns the new community id. The community starts `pending`.
create or replace function public.community_create(
  p_name       text,
  p_genre      text,
  p_guidelines text,
  p_invites    jsonb default '[]'::jsonb
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id       uuid;
  v_hashtag  text;
  v_base     text;
  v_n        integer := 1;
  v_inv      jsonb;
  v_uid      uuid;
  v_role     text;
  v_caller   uuid := auth.uid();
begin
  if v_caller is null then raise exception 'not authenticated'; end if;
  if (select badge_tier from public.profiles where id = v_caller) is distinct from 'diamond' then
    raise exception 'diamond badge required to create a community';
  end if;
  p_name := trim(coalesce(p_name, ''));
  if length(p_name) < 2 then raise exception 'community name too short'; end if;
  if exists (select 1 from public.communities where lower(name) = lower(p_name)) then
    raise exception 'community name taken';
  end if;

  -- Derive a unique hashtag token from the name.
  v_hashtag := lower(regexp_replace(p_name, '[^a-zA-Z0-9]', '', 'g'));
  if length(v_hashtag) = 0 then v_hashtag := 'community'; end if;
  v_base := v_hashtag;
  while exists (select 1 from public.communities where lower(hashtag) = v_hashtag) loop
    v_n := v_n + 1;
    v_hashtag := v_base || v_n::text;
  end loop;

  insert into public.communities (name, hashtag, genre, guidelines, owner_id, member_count)
  values (p_name, v_hashtag, lower(coalesce(p_genre, '')), nullif(trim(coalesce(p_guidelines,'')), ''), v_caller, 1)
  returning id into v_id;

  -- Owner membership (active).
  insert into public.community_members (community_id, user_id, role, status, joined_at)
  values (v_id, v_caller, 'owner', 'active', now());

  -- Pending invites.
  for v_inv in select * from jsonb_array_elements(coalesce(p_invites, '[]'::jsonb)) loop
    v_uid := nullif(v_inv->>'user_id','')::uuid;
    if v_uid is null or v_uid = v_caller then continue; end if;
    v_role := coalesce(v_inv->>'role', 'member');
    if v_role not in ('member','manager') then v_role := 'member'; end if;
    if v_role = 'manager'
       and (select badge_tier from public.profiles where id = v_uid) not in ('gold','diamond') then
      v_role := 'member';  -- not Gold+ right now → can't be a manager
    end if;
    insert into public.community_members (community_id, user_id, role, status, invited_by)
    values (v_id, v_uid, v_role, 'invited', v_caller)
    on conflict (community_id, user_id) do nothing;
  end loop;

  return v_id;
end; $$;

-- Accept or decline a pending invite.
create or replace function public.community_respond_invite(p_community uuid, p_accept boolean)
returns text language plpgsql security definer set search_path = public as $$
declare v_caller uuid := auth.uid();
begin
  if v_caller is null then raise exception 'not authenticated'; end if;
  if p_accept then
    update public.community_members
       set status = 'active', joined_at = now()
     where community_id = p_community and user_id = v_caller and status = 'invited';
    return 'active';
  else
    delete from public.community_members
     where community_id = p_community and user_id = v_caller and status = 'invited';
    return 'declined';
  end if;
end; $$;

-- Self-join a LIVE community as a member.
create or replace function public.community_join(p_community uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_caller uuid := auth.uid(); v_existing text;
begin
  if v_caller is null then raise exception 'not authenticated'; end if;
  if not public.community_is_live(p_community) then
    raise exception 'community is not live yet';
  end if;
  select status into v_existing from public.community_members
   where community_id = p_community and user_id = v_caller;
  if v_existing = 'banned' then raise exception 'you are banned from this community'; end if;
  if v_existing = 'active' then return 'active'; end if;
  insert into public.community_members (community_id, user_id, role, status, joined_at)
  values (p_community, v_caller, 'member', 'active', now())
  on conflict (community_id, user_id)
    do update set status = 'active', joined_at = now()
     where public.community_members.status <> 'banned';
  return 'active';
end; $$;

-- Leave a community. If the owner leaves, ownership succeeds to the longest-
-- standing active manager (else the longest-standing active member, who is also
-- made the new owner). A community that empties out is archived by the sync
-- trigger. There is always at least one owner while any member remains.
create or replace function public.community_leave(p_community uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_caller uuid := auth.uid(); v_role text; v_heir uuid;
begin
  if v_caller is null then raise exception 'not authenticated'; end if;
  select role into v_role from public.community_members
   where community_id = p_community and user_id = v_caller and status = 'active';
  if not found then return; end if;

  if v_role = 'owner' then
    -- Prefer a manager; fall back to any other active member.
    select user_id into v_heir from public.community_members
     where community_id = p_community and user_id <> v_caller and status = 'active' and role = 'manager'
     order by joined_at asc nulls last limit 1;
    if v_heir is null then
      select user_id into v_heir from public.community_members
       where community_id = p_community and user_id <> v_caller and status = 'active'
       order by joined_at asc nulls last limit 1;
    end if;
    if v_heir is not null then
      update public.community_members set role = 'owner' where community_id = p_community and user_id = v_heir;
      update public.communities set owner_id = v_heir where id = p_community;
      insert into public.community_mod_log (community_id, actor_id, target_id, action, detail)
      values (p_community, v_caller, v_heir, 'transfer', 'ownership on owner leave');
    end if;
  end if;

  delete from public.community_members where community_id = p_community and user_id = v_caller;
end; $$;

-- Owner-only: set a member's role. role ∈ ('manager','member','owner'). Promoting
-- to 'manager' requires the target to be Gold+ right now. role='owner' TRANSFERS
-- ownership (the old owner becomes a manager).
create or replace function public.community_set_role(p_community uuid, p_target uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare v_caller uuid := auth.uid();
begin
  if v_caller is null then raise exception 'not authenticated'; end if;
  if (select role from public.community_members
        where community_id = p_community and user_id = v_caller and status = 'active') <> 'owner' then
    raise exception 'only the owner can change roles';
  end if;
  if p_target = v_caller then raise exception 'cannot change your own role'; end if;
  if (select status from public.community_members
        where community_id = p_community and user_id = p_target) is distinct from 'active' then
    raise exception 'target is not an active member';
  end if;

  if p_role = 'manager' then
    if (select badge_tier from public.profiles where id = p_target) not in ('gold','diamond') then
      raise exception 'manager must hold the Gold badge';
    end if;
    update public.community_members set role = 'manager' where community_id = p_community and user_id = p_target;
    insert into public.community_mod_log (community_id, actor_id, target_id, action) values (p_community, v_caller, p_target, 'promote');
  elsif p_role = 'member' then
    update public.community_members set role = 'member' where community_id = p_community and user_id = p_target;
    insert into public.community_mod_log (community_id, actor_id, target_id, action) values (p_community, v_caller, p_target, 'demote');
  elsif p_role = 'owner' then
    update public.community_members set role = 'owner'   where community_id = p_community and user_id = p_target;
    update public.community_members set role = 'manager' where community_id = p_community and user_id = v_caller;
    update public.communities set owner_id = p_target where id = p_community;
    insert into public.community_mod_log (community_id, actor_id, target_id, action) values (p_community, v_caller, p_target, 'transfer');
  else
    raise exception 'invalid role';
  end if;
end; $$;

-- Owner or manager moderation. action ∈ ('ban','unban','mute','unmute','remove').
-- A manager may act only on plain MEMBERS; the owner may act on anyone but self.
create or replace function public.community_moderate(
  p_community uuid, p_target uuid, p_action text, p_mute_minutes integer default 60
) returns void language plpgsql security definer set search_path = public as $$
declare v_caller uuid := auth.uid(); v_caller_role text; v_target_role text;
begin
  if v_caller is null then raise exception 'not authenticated'; end if;
  select role into v_caller_role from public.community_members
   where community_id = p_community and user_id = v_caller and status = 'active';
  if v_caller_role not in ('owner','manager') then raise exception 'not a moderator'; end if;
  if p_target = v_caller then raise exception 'cannot moderate yourself'; end if;

  select role into v_target_role from public.community_members
   where community_id = p_community and user_id = p_target;
  if not found then raise exception 'no such member'; end if;
  -- Managers can only touch plain members; the owner can touch anyone.
  if v_caller_role = 'manager' and v_target_role <> 'member' then
    raise exception 'managers can only moderate members';
  end if;

  if p_action = 'ban' then
    update public.community_members set status = 'banned', role = 'member'
     where community_id = p_community and user_id = p_target;
  elsif p_action = 'unban' then
    update public.community_members set status = 'active', joined_at = coalesce(joined_at, now())
     where community_id = p_community and user_id = p_target;
  elsif p_action = 'mute' then
    update public.community_members set muted_until = now() + make_interval(mins => greatest(p_mute_minutes, 1))
     where community_id = p_community and user_id = p_target;
  elsif p_action = 'unmute' then
    update public.community_members set muted_until = null
     where community_id = p_community and user_id = p_target;
  elsif p_action = 'remove' then
    delete from public.community_members where community_id = p_community and user_id = p_target;
  else
    raise exception 'invalid action';
  end if;

  insert into public.community_mod_log (community_id, actor_id, target_id, action, detail)
  values (p_community, v_caller, p_target, p_action, case when p_action='mute' then p_mute_minutes::text || 'm' else null end);
end; $$;

-- Owner or manager: invite users (as members). Re-inviting a banned user clears
-- the ban back to a pending invite (the owner's "add back after a ban" path).
create or replace function public.community_invite(p_community uuid, p_users jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_caller uuid := auth.uid(); v_role text; v_uid uuid; v_u jsonb;
begin
  if v_caller is null then raise exception 'not authenticated'; end if;
  select role into v_role from public.community_members
   where community_id = p_community and user_id = v_caller and status = 'active';
  if v_role not in ('owner','manager') then raise exception 'not allowed to invite'; end if;

  for v_u in select * from jsonb_array_elements(coalesce(p_users, '[]'::jsonb)) loop
    v_uid := nullif(v_u->>'user_id','')::uuid;
    if v_uid is null or v_uid = v_caller then continue; end if;
    insert into public.community_members (community_id, user_id, role, status, invited_by)
    values (p_community, v_uid, 'member', 'invited', v_caller)
    on conflict (community_id, user_id)
      do update set status = 'invited', invited_by = v_caller
       where public.community_members.status = 'banned';
    insert into public.community_mod_log (community_id, actor_id, target_id, action)
    values (p_community, v_caller, v_uid, 'invite');
  end loop;
end; $$;

-- Owner-only: update the guidelines text.
create or replace function public.community_update_guidelines(p_community uuid, p_guidelines text)
returns void language plpgsql security definer set search_path = public as $$
declare v_caller uuid := auth.uid();
begin
  if v_caller is null then raise exception 'not authenticated'; end if;
  if (select owner_id from public.communities where id = p_community) <> v_caller then
    raise exception 'only the owner can edit guidelines';
  end if;
  update public.communities set guidelines = nullif(trim(coalesce(p_guidelines,'')), ''), updated_at = now()
   where id = p_community;
end; $$;

-- Owner-only: edit the core fields (name, hashtag spelling, genre, guidelines,
-- banner image). Name + hashtag stay unique case-insensitively (excluding self).
-- The hashtag is normalized to an alphanumeric token; posts reference the
-- community by id, so re-spelling the hashtag never breaks existing attributions.
create or replace function public.community_update(
  p_community  uuid,
  p_name       text,
  p_hashtag    text,
  p_genre      text,
  p_guidelines text,
  p_banner_url text
) returns void language plpgsql security definer set search_path = public as $$
declare v_caller uuid := auth.uid(); v_hashtag text;
begin
  if v_caller is null then raise exception 'not authenticated'; end if;
  if (select owner_id from public.communities where id = p_community) <> v_caller then
    raise exception 'only the owner can edit the community';
  end if;

  p_name := trim(coalesce(p_name, ''));
  if length(p_name) < 2 then raise exception 'community name too short'; end if;
  if exists (select 1 from public.communities where lower(name) = lower(p_name) and id <> p_community) then
    raise exception 'community name taken';
  end if;

  v_hashtag := lower(regexp_replace(coalesce(p_hashtag, ''), '[^a-zA-Z0-9]', '', 'g'));
  if length(v_hashtag) = 0 then raise exception 'hashtag too short'; end if;
  if exists (select 1 from public.communities where lower(hashtag) = v_hashtag and id <> p_community) then
    raise exception 'hashtag taken';
  end if;

  update public.communities set
    name       = p_name,
    hashtag    = v_hashtag,
    genre      = lower(nullif(trim(coalesce(p_genre, '')), '')),
    guidelines = nullif(trim(coalesce(p_guidelines, '')), ''),
    banner_url = nullif(trim(coalesce(p_banner_url, '')), ''),
    updated_at = now()
  where id = p_community;
end; $$;

grant execute on function public.community_create(text, text, text, jsonb)        to authenticated;
grant execute on function public.community_respond_invite(uuid, boolean)          to authenticated;
grant execute on function public.community_join(uuid)                             to authenticated;
grant execute on function public.community_leave(uuid)                            to authenticated;
grant execute on function public.community_set_role(uuid, uuid, text)             to authenticated;
grant execute on function public.community_moderate(uuid, uuid, text, integer)    to authenticated;
grant execute on function public.community_invite(uuid, jsonb)                    to authenticated;
grant execute on function public.community_update_guidelines(uuid, text)          to authenticated;
grant execute on function public.community_update(uuid, text, text, text, text, text) to authenticated;
grant execute on function public.is_community_member(uuid, uuid)                  to authenticated, anon;
grant execute on function public.community_is_live(uuid)                          to authenticated, anon;
