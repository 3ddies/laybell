import { supabase } from './supabase';
import { isAudioPost } from './genres';

// Remix (owner, 2026-09-23) — the shared data layer.
//
// One feature: react to a video. You record your clip and pick a LAYOUT for how
// it sits with the original:
//   * side_by_side — your clip and the original beside each other.
//   * top_bottom   — your clip and the original stacked.
//   * pip          — the original as a small window over your full-screen clip.
//   * green_screen — you keyed over the original as a background. RESERVED (the
//                    schema allows it) but not offered yet: true keying needs
//                    on-device person segmentation (native), so it ships with the
//                    native bake, not this playback-time interim.
//
// Composition is done at PLAYBACK (JS) for now: the new post is an ordinary video
// (your recorded clip is its media_url) that carries source_post_id +
// composition_kind (the layout); the player fetches the source and lays the two
// out. No baked file yet (that's the native follow-up).
//
// Audio: every layout is a REACTION, so your clip is heard and the original is
// muted by default — the player offers a tap to bring the original's sound in
// (for a sing-along / duet).

// A COMMENTARY layout — the two clips play together.
export type CompositionLayout = 'pip' | 'pip_flip' | 'side_by_side' | 'top_bottom' | 'green_screen';

// What's stored in posts.composition_kind: a commentary layout, or 'add' (the
// original plays first — cropped via source_trim_* — then your clip).
export type CompositionKind = CompositionLayout | 'add';

// The two modes the composer offers.
export type CompositionMode = 'commentary' | 'add';

// The two offered layouts — both corner overlays, which suit a vertical reaction:
//   pip      — YOUR reaction full-screen, the ORIGINAL in a small top-right window.
//   pip_flip — the ORIGINAL full-screen, YOUR reaction in a small top-right window.
// (The old side_by_side / top_bottom looked bad full-screen in reels and were
// dropped as offerings. green_screen ships later, native — it will be these same
// two views with the background keyed. side_by_side/top_bottom stay in the type only
// so any older post still resolves — the player renders them as pip.)
export const REMIX_LAYOUTS: CompositionLayout[] = ['pip', 'pip_flip'];

export type SourcePost = {
  id: string;
  userId: string | null;
  type: string;
  isAudio: boolean;           // song / podcast / audiobook — react with the track under you
  mediaUrl: string;
  coverUrl: string | null;    // audio art (audio has no video frame)
  aspectRatio: string | null;
  thumbnailUrl: string | null;
  caption: string;
  durationSec: number | null; // the original's length — for the add-mode crop UI
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

function mapSourceRow(data: any): SourcePost {
  const p = data;
  const prof = Array.isArray(p.profiles) ? p.profiles[0] : p.profiles;
  return {
    id: p.id,
    userId: p.user_id ?? null,
    type: p.type ?? '',
    isAudio: isAudioPost(p.type),
    mediaUrl: p.media_url,
    coverUrl: p.cover_url ?? null,
    aspectRatio: p.aspect_ratio ?? null,
    thumbnailUrl: p.thumbnail_url ?? null,
    caption: p.caption ?? '',
    durationSec: typeof p.duration_seconds === 'number' ? p.duration_seconds : null,
    username: prof?.username ?? null,
    displayName: prof?.display_name ?? null,
    avatarUrl: prof?.avatar_url ?? null,
  };
}

// A short-lived in-memory cache + in-flight dedupe for source posts. The SAME
// original is otherwise re-queried on every CompositionPlayer mount — the feed
// mounts one per focused card AND its warm neighbours, the reel and post viewer each
// mount their own, two reactions to one original fetch it independently, and a
// scroll-away-and-back refetches — all identical round-trips (each with a profiles
// join) that gate when the second pane can appear. The fields we read
// (media/thumbnail/duration/profile) are immutable for a session; a few-minute TTL
// bounds staleness if an original is deleted/privated mid-session. Transient errors
// are NOT cached, so a blip can still recover on the next mount.
const _sourceCache = new Map<string, { at: number; value: SourcePost | null }>();
const _sourceInflight = new Map<string, Promise<SourcePost | null>>();
const SOURCE_CACHE_TTL_MS = 5 * 60 * 1000;

// The original a remix is built on. Read through the normal post RLS (public
// posts are readable), so a private/blocked original simply returns null and the
// player falls back to the creator's own clip.
export async function fetchSourcePost(postId: string): Promise<SourcePost | null> {
  const hit = _sourceCache.get(postId);
  if (hit && Date.now() - hit.at < SOURCE_CACHE_TTL_MS) return hit.value;
  const flying = _sourceInflight.get(postId);
  if (flying) return flying;
  const run = (async (): Promise<SourcePost | null> => {
    const { data, error } = await supabase
      .from('posts')
      .select('id, user_id, type, media_url, cover_url, aspect_ratio, thumbnail_url, caption, duration_seconds, profiles!posts_user_id_fkey (username, display_name, avatar_url)')
      .eq('id', postId)
      .maybeSingle();
    if (error) return null; // transient (network/RLS hiccup) — don't cache; allow retry
    const value = data ? mapSourceRow(data) : null;
    _sourceCache.set(postId, { at: Date.now(), value });
    return value;
  })();
  _sourceInflight.set(postId, run);
  try { return await run; }
  finally { _sourceInflight.delete(postId); }
}
