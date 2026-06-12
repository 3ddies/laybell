-- Public playlists: discoverability + listen tracking.
-- Run manually in the Supabase SQL editor (same as badges.sql etc.).
--
-- Model:
--  * playlists.is_public already exists; this adds a denormalized play_count.
--  * A "listen" = a NON-owner starting playback of a public playlist (counted
--    via the bump_playlist_play RPC below — owners can't inflate their own).
--  * Creation limits (public playlists per badge tier: none 0 / bronze 1 /
--    silver 2 / gold 3 / diamond 6) are enforced client-side at creation time.
--  * Curator badge milestones read SUM(play_count) over the user's public
--    playlists (computed client-side in lib/badges.ts — no schema needed).

-- Listen counter.
alter table public.playlists
  add column if not exists play_count integer not null default 0;

-- Everyone may view public playlists (additive to the existing owner-only
-- policies — permissive policies OR together).
drop policy if exists "Public playlists are viewable by everyone" on public.playlists;
create policy "Public playlists are viewable by everyone"
  on public.playlists for select
  using (is_public = true);

drop policy if exists "Tracks of public playlists are viewable by everyone" on public.playlist_tracks;
create policy "Tracks of public playlists are viewable by everyone"
  on public.playlist_tracks for select
  using (
    exists (
      select 1 from public.playlists p
      where p.id = playlist_id and p.is_public = true
    )
  );

-- Track freshness: updated_at powers the "Upcoming Playlists" scoring
-- (recency of updates). Touched by a trigger whenever tracks are added or
-- removed, so the app never has to maintain it.
alter table public.playlists
  add column if not exists updated_at timestamptz not null default now();

create or replace function public.touch_playlist_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.playlists
     set updated_at = now()
   where id = coalesce(new.playlist_id, old.playlist_id);
  return coalesce(new, old);
end;
$$;

drop trigger if exists playlist_tracks_touch on public.playlist_tracks;
create trigger playlist_tracks_touch
  after insert or delete on public.playlist_tracks
  for each row execute function public.touch_playlist_updated_at();

-- Owners can reorder tracks (position updates from the playlist editor).
drop policy if exists "Reorder tracks in own playlists" on public.playlist_tracks;
create policy "Reorder tracks in own playlists"
  on public.playlist_tracks for update
  using (
    exists (
      select 1 from public.playlists p
      where p.id = playlist_id and p.user_id = auth.uid()
    )
  );

-- Owners can flip a playlist between public and private.
drop policy if exists "Users can update their own playlists" on public.playlists;
create policy "Users can update their own playlists"
  on public.playlists for update
  using (auth.uid() = user_id);

-- Count a listen. SECURITY DEFINER so a listener can bump a row they don't
-- own; the WHERE clause enforces public-only and excludes the owner.
create or replace function public.bump_playlist_play(p_playlist_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.playlists
     set play_count = play_count + 1
   where id = p_playlist_id
     and is_public = true
     and user_id <> auth.uid();
end;
$$;

grant execute on function public.bump_playlist_play(uuid) to authenticated;
