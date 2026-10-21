import { supabase } from './supabase';
import type { PickedSong } from '../components/SongBrowser';

// The track auto-music lays over a silent video: the most-streamed SONG whose
// creator opted it in as a sound and hasn't withdrawn it. The consent gate is the
// same one SongBrowser's "All" tab applies — attaching audio to a video is
// synchronisation, which only the uploader's own opt-in licenses (sound_optin.sql),
// so a sound that isn't opted in can never be suggested here either.
//
// 'audio' only, deliberately: podcasts and audiobooks are opt-in sounds too, but
// they are talking, not music, and make poor background tracks.
const SUGGEST_SELECT =
  'id, caption, cover_url, user_id, profiles!posts_user_id_fkey(id, username, display_name)';

/**
 * The song to suggest as background music, or null when none qualifies or the query
 * fails (the caller then adds nothing). `excludeUserId` keeps a creator's own tracks
 * out of their own suggestions when given.
 */
export async function fetchSuggestedSound(excludeUserId?: string | null): Promise<PickedSong | null> {
  try {
    let req = supabase
      .from('posts')
      .select(SUGGEST_SELECT)
      .eq('is_public', true)
      .eq('type', 'audio')
      .eq('sound_opt_in', true)
      .is('sound_withdrawn_at', null)
      .is('publish_at', null)
      .is('archived_at', null)
      .order('stream_count', { ascending: false })
      .limit(24);
    if (excludeUserId) req = req.neq('user_id', excludeUserId);

    const { data, error } = await req;
    if (error || !data || data.length === 0) return null;
    // Pick one of the top trending sounds at random rather than always the #1, so the
    // same artist isn't attached to every silent video — it spreads the "your sound
    // was used" notifications across creators (which encourages them) and gives posts
    // variety, while staying inside the most-streamed pool.
    const p = data[Math.floor(Math.random() * data.length)] as any;
    return {
      id: p.id,
      title: p.caption || 'Audio track',
      artist: p.profiles?.display_name || p.profiles?.username || 'Unknown artist',
      artistId: p.profiles?.id || p.user_id,
      cover: p.cover_url ?? null,
    };
  } catch {
    return null;
  }
}
