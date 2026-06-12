import { supabase } from './supabase';
import { publicPlaylistLimit, type Tier } from './badges';

export type OwnedPlaylist = {
  id: string;
  is_public: boolean;
  created_at: string;
  play_count?: number | null;
};

// Which of a user's PUBLIC playlists hold an active slot for the given EARNED
// tier: most-listened first, ties broken by oldest. Anything past the limit is
// "locked" (a demotion keeps the playlist but greys it out) — still visible
// and playable for the owner, hidden from public discovery until a slot frees
// up (re-earning the badge, or making an active playlist private).
export function activePublicIds(playlists: OwnedPlaylist[], tier: Tier | null): Set<string> {
  const limit = publicPlaylistLimit(tier);
  const ranked = playlists
    .filter(p => p.is_public)
    .sort((a, b) =>
      ((b.play_count ?? 0) - (a.play_count ?? 0)) ||
      (new Date(a.created_at).getTime() - new Date(b.created_at).getTime()));
  return new Set(ranked.slice(0, limit).map(p => p.id));
}

// First-track cover (lowest position) for each playlist — a playlist's face.
export async function fetchFirstTrackCovers(playlistIds: string[]): Promise<Record<string, string | null>> {
  if (!playlistIds.length) return {};
  const { data } = await supabase
    .from('playlist_tracks')
    .select('playlist_id, position, posts(cover_url, thumbnail_url)')
    .in('playlist_id', playlistIds)
    .order('position', { ascending: true });
  const out: Record<string, string | null> = {};
  for (const t of (data ?? []) as any[]) {
    if (!(t.playlist_id in out)) out[t.playlist_id] = t.posts?.cover_url ?? t.posts?.thumbnail_url ?? null;
  }
  return out;
}
