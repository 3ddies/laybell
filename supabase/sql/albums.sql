-- Albums — a creator's own tracks, gathered and ordered by them.
--
-- Run manually in the Supabase SQL editor (same as badges.sql, public_playlists.sql).
-- ADDITIVE ONLY: two new tables and their policies. Nothing existing is altered,
-- so the shipped 1.0.0 build — which knows nothing about albums — is unaffected.
--
-- WHY NOT PLAYLISTS. A playlist is a listener's collection of anyone's music and
-- lives on the Music tab as a thing to discover. An album is an ARTIST'S
-- statement about their own work: it belongs on their profile, it is ordered
-- deliberately, and every track in it is theirs. Those differences are enforced
-- here (see the two triggers), not left to the client to remember.
--
-- Model:
--  * albums          — one row per release, owned by a user.
--  * album_tracks    — which of the owner's audio posts are on it, in order,
--                      each with an OPTIONAL display title.
--
-- The title override is the point of that last column. Fixing a spelling inside
-- an album must not rewrite the published post's caption: the post is already
-- out there, has already been seen, and may be in someone's playlist. So the
-- album carries its own name for the track and falls back to the caption.

create table if not exists public.albums (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text not null,
  -- Optional. With none, the client falls back to the first track's cover, so an
  -- album always has a face without forcing the artist to make a second one.
  cover_url   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists albums_user_created_idx
  on public.albums (user_id, created_at desc);

create table if not exists public.album_tracks (
  album_id  uuid not null references public.albums(id) on delete cascade,
  post_id   uuid not null references public.posts(id) on delete cascade,
  position  integer not null default 0,
  -- The name shown IN this album. Null = use the post's caption.
  title     text,
  added_at  timestamptz not null default now(),
  primary key (album_id, post_id)
);

create index if not exists album_tracks_album_pos_idx
  on public.album_tracks (album_id, position);
-- Answers "which albums is this track on?" without scanning, which the track
-- row and the delete path both need.
create index if not exists album_tracks_post_idx
  on public.album_tracks (post_id);

alter table public.albums enable row level security;
alter table public.album_tracks enable row level security;

-- ── Reading ────────────────────────────────────────────────────────────────
-- Albums are a profile surface, so anyone who can see the profile can see them.
-- Note what this does NOT do: it does not make the TRACKS visible. Joining
-- posts applies posts' own RLS, so a private or archived song simply drops out
-- of someone else's view of the album while staying in the owner's.
--
-- ⚠️ RLS here cannot see `profiles.hidden` — there is no policy on profiles at
-- all (see the public-surface notes). A hidden account's albums are hidden by
-- the same app-code check that hides everything else of theirs, and any new
-- crawler-facing surface must do that check itself.
drop policy if exists "Albums are viewable by everyone" on public.albums;
create policy "Albums are viewable by everyone"
  on public.albums for select using (true);

drop policy if exists "Album tracks are viewable by everyone" on public.album_tracks;
create policy "Album tracks are viewable by everyone"
  on public.album_tracks for select using (true);

-- ── Writing: owner only, all four verbs ────────────────────────────────────
drop policy if exists "Users manage their own albums" on public.albums;
create policy "Users manage their own albums"
  on public.albums for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users manage tracks on their own albums" on public.album_tracks;
create policy "Users manage tracks on their own albums"
  on public.album_tracks for all
  using (exists (select 1 from public.albums a where a.id = album_id and a.user_id = auth.uid()))
  with check (exists (select 1 from public.albums a where a.id = album_id and a.user_id = auth.uid()));

-- ── An album holds the OWNER'S OWN AUDIO, and the database says so ─────────
-- The RLS above only proves the album belongs to you. It would still allow
-- adding someone else's song, or a video, to your own album — and "an artist's
-- own tracks" is the whole definition of the thing. A client-side check would
-- hold until the first code path that forgot it.
create or replace function public.enforce_album_track()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_post_owner uuid;
  v_type text;
begin
  select user_id into v_owner from public.albums where id = new.album_id;
  select user_id, type into v_post_owner, v_type from public.posts where id = new.post_id;

  if v_post_owner is null then
    raise exception 'album_tracks: post % does not exist', new.post_id;
  end if;
  if v_post_owner <> v_owner then
    raise exception 'album_tracks: an album may only contain its owner''s own tracks';
  end if;
  if v_type <> 'audio' then
    raise exception 'album_tracks: only audio posts can be album tracks (got %)', v_type;
  end if;
  return new;
end;
$$;

drop trigger if exists album_tracks_enforce on public.album_tracks;
create trigger album_tracks_enforce
  before insert or update on public.album_tracks
  for each row execute function public.enforce_album_track();

-- ── Freshness ──────────────────────────────────────────────────────────────
-- updated_at is what "recently worked on" reads from, and the app should never
-- have to remember to maintain it. Touched by any change to the track list.
create or replace function public.touch_album_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.albums
     set updated_at = now()
   where id = coalesce(new.album_id, old.album_id);
  return coalesce(new, old);
end;
$$;

drop trigger if exists album_tracks_touch on public.album_tracks;
create trigger album_tracks_touch
  after insert or update or delete on public.album_tracks
  for each row execute function public.touch_album_updated_at();

-- ── Verify ─────────────────────────────────────────────────────────────────
-- Expect: 2 tables, 4 policies, 2 triggers on album_tracks.
--
--   select count(*) from information_schema.tables
--    where table_schema = 'public' and table_name in ('albums','album_tracks');
--   select tablename, policyname from pg_policies
--    where tablename in ('albums','album_tracks') order by tablename, policyname;
--   select tgname from pg_trigger
--    where tgrelid = 'public.album_tracks'::regclass and not tgisinternal;
