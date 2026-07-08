-- Laybell-owned "official" communities + "Girl space".
-- Run in the Supabase Dashboard → SQL Editor (AFTER communities.sql).
--
-- Adds default topic tabs (News & Media, Sports, … + the feminine "Girl space"
-- tabs Makeup/Beauty) that EVERYONE can browse and post to WITHOUT joining. They
-- are marked is_official + open_posting and seeded 'live'. `space='girl'` flags
-- the feminine tabs, which the feed soft-down-ranks for men (lib/feedScorer).
--
-- Ownership: for now these have no owner; a Laybell admin (public.laybell_admins)
-- can take a managing role via laybell_join_as_manager() and moderate with the
-- normal community tools. Add your own account id to laybell_admins (bottom).

do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'communities') then
    raise exception 'Run communities.sql before laybell_communities.sql.';
  end if;
end $$;

-- ── Columns ───────────────────────────────────────────────────────────────────
alter table public.communities add column if not exists is_official  boolean not null default false;
alter table public.communities add column if not exists open_posting boolean not null default false;
alter table public.communities add column if not exists space        text;  -- null | 'girl' (Girl space)
-- Official tabs are topic-based, not music genres — allow a NULL genre.
alter table public.communities alter column genre drop not null;
-- Official tabs have NO owner (managed via laybell_admins) — allow a null owner.
alter table public.communities alter column owner_id drop not null;

create index if not exists communities_official_idx on public.communities (is_official) where is_official;
create index if not exists communities_space_idx     on public.communities (space) where space is not null;

-- ── Laybell admins (staff) ────────────────────────────────────────────────────
create table if not exists public.laybell_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.laybell_admins enable row level security;
-- A user may check whether THEY are an admin; the list isn't otherwise exposed.
drop policy if exists "See your own admin row" on public.laybell_admins;
create policy "See your own admin row" on public.laybell_admins for select using (user_id = auth.uid());
-- No client writes — manage rows manually / via the service role.

-- ── Post guard: allow posting to official OPEN communities without membership ──
-- Same as communities.sql's guard, except an official open_posting community
-- accepts posts from any signed-in user (an explicit ban/mute still blocks them).
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
  if new.is_public is not true then
    raise exception 'community posts must be public';
  end if;
  if array_length(new.community_ids, 1) > 3 then
    raise exception 'a post can be in at most 3 communities';
  end if;
  foreach cid in array new.community_ids loop
    select c.status as cstatus, coalesce(c.open_posting, false) as open,
           cm.status as mstatus, cm.muted_until
      into mem
      from public.communities c
      left join public.community_members cm
        on cm.community_id = c.id and cm.user_id = new.user_id
     where c.id = cid;
    if not found then raise exception 'a chosen community does not exist'; end if;
    if mem.cstatus <> 'live' then raise exception 'a chosen community is not live yet'; end if;
    if mem.mstatus = 'banned' then raise exception 'you are banned from a chosen community'; end if;
    if mem.muted_until is not null and mem.muted_until > now() then
      raise exception 'posting is temporarily restricted in a chosen community';
    end if;
    -- Membership is required only for NON-open communities.
    if not mem.open and mem.mstatus is distinct from 'active' then
      raise exception 'not a member of a chosen community';
    end if;
  end loop;
  -- One community per FOUNDER: at most one community from the same founding user
  -- (owner). All Laybell "official" tabs count as ONE founder (Laybell), so a post
  -- can carry at most one official tab too.
  if exists (
    select 1 from (
      select coalesce(c.owner_id::text,
                      case when coalesce(c.is_official, false) then 'laybell' else c.id::text end) as founder
        from public.communities c
       where c.id = any(new.community_ids)
    ) f
    group by f.founder
    having count(*) > 1
  ) then
    raise exception 'one community per founder';
  end if;
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
  new.genre := v_genre;
  return new;
end; $$;

-- ── Membership sync: never auto-archive an OFFICIAL community when it's empty ──
create or replace function public.community_sync_membership()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_community uuid := coalesce(new.community_id, old.community_id);
  v_active    integer;
  v_managers  integer;
  v_status    text;
  v_official  boolean;
begin
  select count(*) filter (where status = 'active'),
         count(*) filter (where status = 'active' and role = 'manager')
    into v_active, v_managers
    from public.community_members
   where community_id = v_community;

  select status, coalesce(is_official, false) into v_status, v_official
    from public.communities where id = v_community;
  if not found then return null; end if;

  update public.communities set member_count = v_active, updated_at = now()
   where id = v_community;

  if v_status = 'pending' and v_active >= 7 and v_managers >= 1 then
    update public.communities set status = 'live', updated_at = now() where id = v_community;
  end if;

  -- Official tabs are permanent — they never archive on becoming memberless.
  if v_active = 0 and v_status <> 'archived' and not v_official then
    update public.communities set status = 'archived', updated_at = now() where id = v_community;
  end if;

  return null;
end; $$;

-- ── Admin: take a managing seat in an official community (then use the normal
--    community owner/manager tools to moderate). Idempotent. ───────────────────
create or replace function public.laybell_join_as_manager(p_community uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  if not exists (select 1 from public.laybell_admins where user_id = v_uid) then
    raise exception 'not_admin';
  end if;
  if not exists (select 1 from public.communities where id = p_community and is_official) then
    raise exception 'not_official';
  end if;
  insert into public.community_members (community_id, user_id, role, status, joined_at)
  values (p_community, v_uid, 'manager', 'active', now())
  on conflict (community_id, user_id) do update set role = 'manager', status = 'active';
end; $$;
grant execute on function public.laybell_join_as_manager(uuid) to authenticated;

-- ── Seed the official tabs (idempotent — skips any that already exist by name) ──
do $$
declare rec record;
begin
  for rec in select * from (values
    ('News & Media', 'newsmedia',     null),
    ('Sports',       'sports',        null),
    ('Entertainment','entertainment', null),
    ('Politics',     'politics',      null),
    ('Food',         'food',          null),
    ('Education',    'education',     null),
    ('Gaming',       'gaming',        null),
    ('Health',       'health',        null),
    ('Fashion',      'fashion',       null),
    ('Lifestyle',    'lifestyle',     null),
    ('Makeup',       'makeup',        'girl'),
    ('Beauty',       'beauty',        'girl')
  ) as t(name, hashtag, space) loop
    insert into public.communities
      (name, hashtag, genre, guidelines, owner_id, status, member_count, post_count, is_official, open_posting, space)
    select rec.name, rec.hashtag, null, 'Be creative and follow all Laybell Guidelines',
           null, 'live', 0, 0, true, true, rec.space
    where not exists (select 1 from public.communities where lower(name) = lower(rec.name));
  end loop;
end $$;

-- ── REQUIRED: make YOUR account a Laybell admin so you can manage the official
--    tabs. Replace the id, then run. (Find it: select id from auth.users where
--    email = 'you@example.com';) Repeat for the future 'Laybell' account.
-- insert into public.laybell_admins (user_id) values ('<YOUR-AUTH-USER-ID>')
--   on conflict do nothing;
