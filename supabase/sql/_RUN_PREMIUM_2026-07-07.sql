-- ════════════════════════════════════════════════════════════════════════════
-- LAYBELL — Premium revision + Laybell-owned communities.
-- Paste this WHOLE file into the Supabase Dashboard → SQL Editor and Run.
--
-- Everything is IDEMPOTENT — safe to run more than once, and safe if some parts
-- were already applied. Sections run in dependency order.
--
-- Prereq (already run earlier this project): spotlight.sql, live_features.sql,
-- communities.sql, badges.sql, ad_ecosystem.sql. The premium base (premium.sql)
-- is INCLUDED below as Section 0. The guards raise a clear error if a remaining
-- prereq is still missing.
--
-- After running: do the ONE manual step at the very bottom (add your account to
-- laybell_admins) so you can manage the official community tabs.
-- ════════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════════
-- 0) PREMIUM BASE (premium.sql) — profiles.premium_until + is_premium(). Written
--    ONLY by the revenuecat-webhook (service role); a protect trigger stops a
--    client self-granting Premium. Included here because Sections 1 & 3 need it.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.profiles
  add column if not exists premium_until timestamptz;

create or replace function public.is_premium(p_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select premium_until from public.profiles where id = p_id) > now(), false);
$$;
grant execute on function public.is_premium(uuid) to authenticated;

create or replace function public.protect_premium_until()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and new.premium_until is distinct from old.premium_until then
    new.premium_until := old.premium_until;
  end if;
  return new;
end; $$;

drop trigger if exists profiles_protect_premium on public.profiles;
create trigger profiles_protect_premium
  before update on public.profiles
  for each row execute function public.protect_premium_until();


-- ════════════════════════════════════════════════════════════════════════════
-- 1) LIVE DONATIONS — viewers tip a live host; PREMIUM hosts get paid.
--    15% Laybell fee + estimated tax (added on top) + the premium lock are all
--    enforced server-side by the donation_guard trigger. Payments are SIMULATED.
-- ════════════════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'live_streams') then
    raise exception 'Run live_features.sql before this (public.live_streams is missing).';
  end if;
  if not exists (select 1 from information_schema.routines
                 where routine_schema = 'public' and routine_name = 'is_premium') then
    raise exception 'Run premium.sql before this (public.is_premium is missing).';
  end if;
end $$;

create table if not exists public.donations (
  id                    uuid primary key default gen_random_uuid(),
  donor_id              uuid not null references auth.users(id) on delete cascade,
  streamer_id           uuid not null references auth.users(id) on delete cascade,
  stream_id             uuid not null references public.live_streams(id) on delete cascade,
  amount_cents          integer not null check (amount_cents > 0),   -- the tip itself
  currency              text not null default 'usd',
  laybell_fee_cents     integer not null default 0,                  -- Laybell's 15% cut of the tip
  tax_cents             integer not null default 0,                  -- estimated tax, added on top (donor pays)
  streamer_payout_cents integer not null default 0,                  -- amount_cents - laybell_fee_cents
  provider              text not null default 'simulated',           -- 'simulated' until a real processor
  provider_ref          text,
  status                text not null default 'succeeded' check (status in ('succeeded', 'refunded', 'failed', 'pending')),
  created_at            timestamptz not null default now(),
  processed_at          timestamptz
);

create index if not exists donations_streamer_idx on public.donations (streamer_id, created_at desc);
create index if not exists donations_stream_idx   on public.donations (stream_id, created_at desc);
create index if not exists donations_donor_idx     on public.donations (donor_id, created_at desc);

alter table public.donations enable row level security;

drop policy if exists "Parties can view donations" on public.donations;
create policy "Parties can view donations" on public.donations for select
  using (auth.uid() = donor_id or auth.uid() = streamer_id);

drop policy if exists "Donors can donate" on public.donations;
create policy "Donors can donate" on public.donations for insert
  with check (auth.uid() = donor_id and amount_cents > 0);

create or replace function public.donation_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_host uuid;
begin
  select user_id into v_host from public.live_streams where id = new.stream_id;
  if v_host is null then
    raise exception 'stream_not_found';
  end if;
  new.streamer_id := v_host;

  if new.donor_id = v_host then
    raise exception 'cannot_donate_to_self';
  end if;

  if not public.is_premium(v_host) then
    raise exception 'streamer_not_premium';
  end if;

  new.laybell_fee_cents     := round(new.amount_cents * 0.15);
  new.tax_cents             := round(new.amount_cents * 0.06);
  new.streamer_payout_cents := new.amount_cents - new.laybell_fee_cents;
  new.provider              := coalesce(new.provider, 'simulated');
  new.status                := coalesce(new.status, 'succeeded');
  new.processed_at          := now();
  return new;
end; $$;

drop trigger if exists donations_guard on public.donations;
create trigger donations_guard
  before insert on public.donations
  for each row execute function public.donation_guard();

create or replace function public.donation_earnings()
returns table (total_cents bigint, donation_count bigint) language sql stable security definer set search_path = public as $$
  select coalesce(sum(streamer_payout_cents), 0)::bigint, count(*)::bigint
  from public.donations
  where streamer_id = auth.uid() and status = 'succeeded';
$$;
grant execute on function public.donation_earnings() to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- 2) FOLLOWER INSIGHTS — an append-only follow_events log so "who unfollowed you"
--    is queryable. Written ONLY by triggers on public.follows. (Unfollows are
--    tracked from the moment this runs — it can't back-fill past unfollows.)
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.follow_events (
  id           uuid primary key default gen_random_uuid(),
  follower_id  uuid not null references auth.users(id) on delete cascade,
  following_id uuid not null references auth.users(id) on delete cascade,
  action       text not null check (action in ('follow', 'unfollow')),
  created_at   timestamptz not null default now()
);

create index if not exists follow_events_target_idx on public.follow_events (following_id, action, created_at desc);

alter table public.follow_events enable row level security;

drop policy if exists "See your own follow events" on public.follow_events;
create policy "See your own follow events" on public.follow_events for select
  using (auth.uid() = following_id);

create or replace function public.log_follow_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.follow_events (follower_id, following_id, action)
      values (new.follower_id, new.following_id, 'follow');
    return new;
  elsif tg_op = 'DELETE' then
    insert into public.follow_events (follower_id, following_id, action)
      values (old.follower_id, old.following_id, 'unfollow');
    return old;
  end if;
  return null;
end; $$;

drop trigger if exists follows_log_insert on public.follows;
create trigger follows_log_insert
  after insert on public.follows
  for each row execute function public.log_follow_event();

drop trigger if exists follows_log_delete on public.follows;
create trigger follows_log_delete
  after delete on public.follows
  for each row execute function public.log_follow_event();


-- ════════════════════════════════════════════════════════════════════════════
-- 3) MONTHLY SPOTLIGHT BOOST — one FREE 1-day Spotlight per calendar month for
--    Premium. Resets monthly (unused doesn't carry over). Atomic claim RPC.
-- ════════════════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from information_schema.routines
                 where routine_schema = 'public' and routine_name = 'is_premium') then
    raise exception 'Run premium.sql before this (public.is_premium is missing).';
  end if;
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'ad_campaigns') then
    raise exception 'Run spotlight.sql before this (public.ad_campaigns is missing).';
  end if;
end $$;

alter table public.profiles
  add column if not exists spotlight_credit_used_month text;  -- 'YYYY-MM' of last free claim

create or replace function public.protect_spotlight_credit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.spotlight_credit_used_month is distinct from old.spotlight_credit_used_month
     and coalesce(current_setting('app.claiming_spotlight', true), '') <> '1' then
    new.spotlight_credit_used_month := old.spotlight_credit_used_month;
  end if;
  return new;
end; $$;

drop trigger if exists profiles_protect_spotlight_credit on public.profiles;
create trigger profiles_protect_spotlight_credit
  before update on public.profiles
  for each row execute function public.protect_spotlight_credit();

create or replace function public.claim_free_spotlight(p_post_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_month text := to_char(now(), 'YYYY-MM');
  v_used  text;
  v_id    uuid;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  if not public.is_premium(v_uid) then raise exception 'not_premium'; end if;

  select spotlight_credit_used_month into v_used
    from public.profiles where id = v_uid for update;
  if v_used = v_month then raise exception 'already_claimed'; end if;

  if not exists (
    select 1 from public.posts
     where id = p_post_id and user_id = v_uid and is_public = true
  ) then
    raise exception 'invalid_post';
  end if;

  insert into public.ad_campaigns
    (user_id, post_id, package_key, duration_days, price_cents, weight, status, starts_at, ends_at)
  values
    (v_uid, p_post_id, '1d', 1, 0, 2, 'active', now(), now() + interval '1 day')
  returning id into v_id;

  perform set_config('app.claiming_spotlight', '1', true);
  update public.profiles set spotlight_credit_used_month = v_month where id = v_uid;

  return v_id;
end; $$;
grant execute on function public.claim_free_spotlight(uuid) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- 4) LAYBELL-OWNED COMMUNITIES + "GIRL SPACE" — default topic tabs everyone can
--    browse & post to without joining; Makeup/Beauty are the feminine "Girl
--    space" tabs (soft-down-ranked for men in the feed, client-side).
--    NOTE: this REWRITES community_post_guard + community_sync_membership. If you
--    ever re-run the base communities.sql, re-run THIS section afterward.
-- ════════════════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'communities') then
    raise exception 'Run communities.sql before this (public.communities is missing).';
  end if;
end $$;

alter table public.communities add column if not exists is_official  boolean not null default false;
alter table public.communities add column if not exists open_posting boolean not null default false;
alter table public.communities add column if not exists space        text;  -- null | 'girl' (Girl space)
alter table public.communities alter column genre drop not null;
-- Official tabs have NO owner (managed via laybell_admins) — allow a null owner.
alter table public.communities alter column owner_id drop not null;

create index if not exists communities_official_idx on public.communities (is_official) where is_official;
create index if not exists communities_space_idx     on public.communities (space) where space is not null;

create table if not exists public.laybell_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.laybell_admins enable row level security;
drop policy if exists "See your own admin row" on public.laybell_admins;
create policy "See your own admin row" on public.laybell_admins for select using (user_id = auth.uid());

-- Post guard: allow posting to official OPEN communities without membership.
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

-- Membership sync: never auto-archive an OFFICIAL community when it's empty.
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

  if v_active = 0 and v_status <> 'archived' and not v_official then
    update public.communities set status = 'archived', updated_at = now() where id = v_community;
  end if;

  return null;
end; $$;

-- Admin: take a managing seat in an official community (then use the normal tools).
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

-- Seed the official tabs (idempotent — skips any that already exist by name).
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


-- ════════════════════════════════════════════════════════════════════════════
-- Done. Reload the app — all of the above is OTA-safe (no rebuild).
--
-- ⬇ ONE MANUAL STEP — make YOUR account a Laybell admin so you can manage the
--   official community tabs. Find your id, then run the insert:
--
--     select id, email from auth.users where email = 'you@example.com';
--
--     insert into public.laybell_admins (user_id)
--       values ('<YOUR-AUTH-USER-ID>')
--       on conflict do nothing;
--
--   (Repeat later for the dedicated 'Laybell' account when you create it.)
-- ════════════════════════════════════════════════════════════════════════════
