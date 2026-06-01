-- playlist_tracks RLS — Supabase
-- Run in the Supabase Dashboard → SQL Editor (anon key cannot alter policies).
-- The add-to-playlist insert fails with "new row violates row-level security"
-- because no INSERT policy exists. These three policies gate access by the
-- ownership/visibility of the parent playlist.

-- READ: tracks of playlists you own, or of any public playlist.
create policy "View tracks of own or public playlists"
on public.playlist_tracks for select
using (
  exists (
    select 1 from public.playlists p
    where p.id = playlist_tracks.playlist_id
      and (p.user_id = auth.uid() or p.is_public = true)
  )
);

-- INSERT: add tracks only to a playlist you own.  ← fixes the reported error
create policy "Add tracks to own playlists"
on public.playlist_tracks for insert
with check (
  exists (
    select 1 from public.playlists p
    where p.id = playlist_tracks.playlist_id
      and p.user_id = auth.uid()
  )
);

-- DELETE: remove tracks only from a playlist you own.
create policy "Remove tracks from own playlists"
on public.playlist_tracks for delete
using (
  exists (
    select 1 from public.playlists p
    where p.id = playlist_tracks.playlist_id
      and p.user_id = auth.uid()
  )
);

-- If any of these names already exist, CREATE will error — that policy is
-- already present and can be skipped. RLS must also be enabled on the table:
--   alter table public.playlist_tracks enable row level security;
