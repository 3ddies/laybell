import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { supabase } from './supabase';
import type { StudioRadioState } from './live';

// STUDIO RADIO — the host plays Laybell songs into a live session.
//
// WHY THE AUDIO DOES NOT TRAVEL THROUGH LIVEKIT. The obvious design is for the
// host to publish the song as a second audio track. It cannot work here and it
// should not:
//   · React Native has no way to turn a file or a remote URL into a
//     MediaStreamTrack, so there is nothing to publish in the first place;
//   · anything that did reach LiveKit would arrive as 32 kbps mono-ish speech
//     Opus that has been through a noise gate — a mix would be destroyed;
//   · and it would cost the host's uplink on every song.
//
// Instead the host broadcasts WHAT is playing and WHERE it is, and every device
// streams the same file from the CDN and plays it locally. Everyone hears the
// master, at full quality, and the session's uplink is untouched. This is the
// same trick the count-in already uses (lib/studio.sendCountIn) — a shared
// clock instead of a shared stream.
//
// The cost is that "in sync" is approximate. Two phones are kept together by
// correcting for clock skew (see hostAt below) and by re-seeking whenever a
// device drifts more than DRIFT_TOLERANCE_MS. It is radio, heard in separate
// rooms on separate headphones — a quarter of a second apart is inaudible.
// It is NOT tight enough to rap over, which is what the count-in is for.

export type RadioTrack = NonNullable<StudioRadioState['track']>;

/** Anything past this and the local player is nudged back to the room's position. */
export const DRIFT_TOLERANCE_MS = 1200;
/** The host re-announces this often, so a dropped packet self-heals. */
export const RADIO_HEARTBEAT_MS = 8000;

const SONG_TYPES = ['audio', 'podcast', 'audiobook'];

type PostRow = {
  id: string;
  caption: string | null;
  media_url: string | null;
  cover_url: string | null;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  profiles?: { username?: string | null; display_name?: string | null } | null;
};

function toTrack(p: PostRow): RadioTrack | null {
  if (!p.media_url) return null;
  return {
    id: p.id,
    title: (p.caption || 'Untitled').slice(0, 120),
    artist: p.profiles?.display_name || p.profiles?.username || '',
    // Songs carry cover_url; thumbnail_url is the fallback, same order the
    // Music tab uses.
    cover: p.cover_url ?? p.thumbnail_url ?? null,
    uri: p.media_url,
    durationMs: p.duration_seconds ? Math.round(p.duration_seconds * 1000) : null,
  };
}

// EVERY COLUMN HERE MUST EXIST. Naming one that does not makes PostgREST answer
// 400, which arrives as `data: null` and reads exactly like "this artist has no
// songs" — which is precisely what happened: the first version asked for
// `duration`, the column is `duration_seconds`, and the crate was empty for
// everyone with no error anywhere. Same trap as `profiles.name` in
// supabase/functions/livekit-token.
const SELECT = 'id, caption, media_url, cover_url, thumbnail_url, duration_seconds, profiles!posts_user_id_fkey (username, display_name)';

/**
 * Songs the host can put on air. Public, non-archived audio only — the same two
 * filters every public surface in this app has to apply by hand, because RLS
 * covers neither `archived_at` nor a hidden author.
 */
export async function searchRadioSongs(term: string, limit = 30): Promise<RadioTrack[]> {
  let q = supabase
    .from('posts')
    .select(SELECT)
    .eq('is_public', true)
    .is('archived_at', null)
    .in('type', SONG_TYPES)
    .not('media_url', 'is', null)
    .limit(limit);

  q = term.trim()
    ? q.ilike('caption', `%${term.trim()}%`)
    : q.order('stream_count', { ascending: false });

  const { data } = await q;
  return ((data ?? []) as PostRow[]).map(toTrack).filter(Boolean) as RadioTrack[];
}

/** The host's own uploads — the fastest path to playing your own record. */
export async function myRadioSongs(userId: string, limit = 40): Promise<RadioTrack[]> {
  const { data } = await supabase
    .from('posts')
    .select(SELECT)
    .eq('user_id', userId)
    .is('archived_at', null)
    .in('type', SONG_TYPES)
    .not('media_url', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  return ((data ?? []) as PostRow[]).map(toTrack).filter(Boolean) as RadioTrack[];
}

/** Songs the host liked. `likes` holds post ids; the posts come back in one go. */
export async function likedRadioSongs(userId: string, limit = 60): Promise<RadioTrack[]> {
  const { data: likes } = await supabase
    .from('likes').select('post_id').eq('user_id', userId)
    .order('created_at', { ascending: false }).limit(limit);
  return tracksByIds((likes ?? []).map((l: { post_id: string }) => l.post_id));
}

/** Songs the host saved. Same shape as likes. */
export async function savedRadioSongs(userId: string, limit = 60): Promise<RadioTrack[]> {
  const { data: saves } = await supabase
    .from('saves').select('post_id').eq('user_id', userId)
    .order('created_at', { ascending: false }).limit(limit);
  return tracksByIds((saves ?? []).map((s: { post_id: string }) => s.post_id));
}

export type RadioPlaylist = { id: string; name: string; cover: string | null; count: number };

/** The host's playlists, for the crate's playlist tab. */
export async function myRadioPlaylists(userId: string): Promise<RadioPlaylist[]> {
  const { data } = await supabase
    .from('playlists').select('id, name').eq('user_id', userId)
    .order('created_at', { ascending: false }).limit(50);
  const rows = (data ?? []) as Array<{ id: string; name: string | null }>;
  if (!rows.length) return [];
  const { data: tracks } = await supabase
    .from('playlist_tracks')
    .select('playlist_id, position, posts(cover_url, thumbnail_url, archived_at)')
    .in('playlist_id', rows.map((r) => r.id))
    .order('position', { ascending: true });
  const cover: Record<string, string | null> = {};
  const count: Record<string, number> = {};
  for (const t of (tracks ?? []) as any[]) {
    if (!t.posts || t.posts.archived_at) continue;   // a deleted track is not a face
    count[t.playlist_id] = (count[t.playlist_id] ?? 0) + 1;
    if (!(t.playlist_id in cover)) cover[t.playlist_id] = t.posts.cover_url ?? t.posts.thumbnail_url ?? null;
  }
  return rows.map((r) => ({
    id: r.id, name: r.name || 'Playlist', cover: cover[r.id] ?? null, count: count[r.id] ?? 0,
  }));
}

/** One playlist, in order — this is what "play my playlist" loads. */
export async function playlistRadioSongs(playlistId: string): Promise<RadioTrack[]> {
  const { data } = await supabase
    .from('playlist_tracks')
    .select('position, post_id')
    .eq('playlist_id', playlistId)
    .order('position', { ascending: true });
  return tracksByIds((data ?? []).map((r: { post_id: string }) => r.post_id));
}

/**
 * Fetch posts by id and return them IN THE ORDER ASKED FOR. PostgREST does not
 * preserve `in()` order, and a playlist that plays back in an arbitrary order is
 * not that playlist.
 */
async function tracksByIds(ids: string[]): Promise<RadioTrack[]> {
  const wanted = ids.filter(Boolean);
  if (!wanted.length) return [];
  const { data } = await supabase
    .from('posts').select(SELECT)
    .in('id', wanted)
    .is('archived_at', null)
    .in('type', SONG_TYPES)
    .not('media_url', 'is', null);
  const byId = new Map<string, RadioTrack>();
  for (const row of (data ?? []) as PostRow[]) {
    const t = toTrack(row);
    if (t) byId.set(t.id, t);
  }
  return wanted.map((id) => byId.get(id)).filter(Boolean) as RadioTrack[];
}

/**
 * Where the room is in the song, right now, in ms.
 *
 * `skewMs` is the receiver's clock minus the host's, measured when the state
 * arrived. Subtracting it converts the host's timeline into this device's, and
 * it matters more than it looks: two phones whose clocks differ by a second
 * play a second apart no matter how good the network is.
 */
export function radioPositionMs(state: StudioRadioState, skewMs = 0): number {
  if (!state.track) return 0;
  if (state.paused) return Math.max(0, state.positionMs);
  const elapsed = (Date.now() - skewMs) - state.startedAt;
  const pos = state.positionMs + Math.max(0, elapsed);
  return state.track.durationMs ? Math.min(pos, state.track.durationMs) : pos;
}

/** True once the room has played past the end of the track. */
export function radioFinished(state: StudioRadioState, skewMs = 0): boolean {
  const dur = state.track?.durationMs;
  if (!dur || state.paused) return false;
  return radioPositionMs(state, skewMs) >= dur - 250;
}

export const emptyRadio = (): StudioRadioState => ({
  track: null, startedAt: Date.now(), positionMs: 0, paused: true, hostAt: Date.now(),
});

/**
 * A player that exists only for the studio.
 *
 * Deliberately NOT the app's AudioContext: that one owns a queue, a notification,
 * a mini-player and an ad break. Handing it the radio would put an audio ad in
 * the middle of a live session and a mini-player on top of the console. This is
 * the same standalone `createAudioPlayer` the ad player uses.
 */
export function createRadioPlayer(uri: string): AudioPlayer {
  return createAudioPlayer({ uri }, { updateInterval: 500, keepAudioSessionActive: true });
}
