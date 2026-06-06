import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

// ─── Seen-posts tracking ─────────────────────────────────────────────────────
// Shared between home and explore so a post shown in either place is
// deprioritised in both on the next session.

const SEEN_KEY     = 'feed_seen_posts_v1';
const SEEN_TTL_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function loadSeenPostIds(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(SEEN_KEY);
    if (!raw) return new Set();
    const map: Record<string, number> = JSON.parse(raw);
    const cutoff = Date.now() - SEEN_TTL_MS;
    return new Set(
      Object.entries(map).filter(([, ts]) => ts > cutoff).map(([id]) => id),
    );
  } catch {
    return new Set();
  }
}

export async function recordSeenPostIds(ids: string[]): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(SEEN_KEY);
    const map: Record<string, number> = raw ? JSON.parse(raw) : {};
    const now = Date.now();
    for (const id of ids) map[id] = now;
    const cutoff = now - SEEN_TTL_MS;
    for (const k of Object.keys(map)) if (map[k] < cutoff) delete map[k];
    await AsyncStorage.setItem(SEEN_KEY, JSON.stringify(map));
  } catch {}
}

// ─── User affinity profile ───────────────────────────────────────────────────
// Built from the user's likes and saves. Caches in AsyncStorage for 30 min
// so it stays fresh without slowing every feed load.
//
// Weights:  save = 5  (deliberate, strong intent)
//           like = 3  (quick engagement)
//
// Each dimension is normalized to [0, 1] so a score of 1.0 means
// "this creator / type / genre is the user's top preference".

const PROFILE_KEY    = 'user_affinity_profile_v1';
const PROFILE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface UserAffinityProfile {
  creatorScores: Record<string, number>; // creator userId → 0–1
  typeScores:    Record<string, number>; // 'audio' | 'video' | 'image' → 0–1
  genreScores:   Record<string, number>; // genre string (lowercase) → 0–1
  builtAt: number;
}

export const EMPTY_PROFILE: UserAffinityProfile = {
  creatorScores: {}, typeScores: {}, genreScores: {}, builtAt: 0,
};

function normalize(raw: Record<string, number>): Record<string, number> {
  const max = Math.max(...Object.values(raw), 1);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = v / max;
  return out;
}

export async function buildAffinityProfile(
  userId: string,
  force = false,
): Promise<UserAffinityProfile> {
  // Return cached profile if still fresh
  if (!force) {
    try {
      const raw = await AsyncStorage.getItem(`${PROFILE_KEY}_${userId}`);
      if (raw) {
        const cached: UserAffinityProfile = JSON.parse(raw);
        if (Date.now() - cached.builtAt < PROFILE_TTL_MS) return cached;
      }
    } catch {}
  }

  // Fetch the user's recent liked and saved post IDs in parallel
  const [{ data: likedRows }, { data: savedRows }] = await Promise.all([
    supabase.from('likes').select('post_id').eq('user_id', userId).limit(60),
    supabase.from('saves').select('post_id').eq('user_id', userId).limit(60),
  ]);

  const likedIds = (likedRows ?? []).map((r: any) => r.post_id as string);
  const savedIds = (savedRows ?? []).map((r: any) => r.post_id as string);
  const allIds   = [...new Set([...likedIds, ...savedIds])];

  if (allIds.length === 0) {
    const profile = { ...EMPTY_PROFILE, builtAt: Date.now() };
    try { await AsyncStorage.setItem(`${PROFILE_KEY}_${userId}`, JSON.stringify(profile)); } catch {}
    return profile;
  }

  // Fetch those posts' metadata to extract creator / type / genre
  const { data: postsMeta } = await supabase
    .from('posts')
    .select('id, user_id, type, genre')
    .in('id', allIds);

  const metaMap: Record<string, { user_id: string; type: string; genre?: string }> = {};
  for (const p of postsMeta ?? []) metaMap[p.id] = p;

  const likedSet = new Set(likedIds);
  const savedSet = new Set(savedIds);

  const creatorRaw: Record<string, number> = {};
  const typeRaw:    Record<string, number> = {};
  const genreRaw:   Record<string, number> = {};

  for (const id of allIds) {
    const p = metaMap[id];
    if (!p) continue;
    const w = (likedSet.has(id) ? 3 : 0) + (savedSet.has(id) ? 5 : 0);
    if (p.user_id) creatorRaw[p.user_id] = (creatorRaw[p.user_id] ?? 0) + w;
    if (p.type)    typeRaw[p.type]       = (typeRaw[p.type]       ?? 0) + w;
    if (p.genre)   genreRaw[p.genre]     = (genreRaw[p.genre]     ?? 0) + w;
  }

  const profile: UserAffinityProfile = {
    creatorScores: normalize(creatorRaw),
    typeScores:    normalize(typeRaw),
    genreScores:   normalize(genreRaw),
    builtAt:       Date.now(),
  };

  try {
    await AsyncStorage.setItem(`${PROFILE_KEY}_${userId}`, JSON.stringify(profile));
  } catch {}

  return profile;
}

// ─── Post scoring ────────────────────────────────────────────────────────────
//
// All multipliers are applied on top of the time-decayed engagement score so
// personalization nudges rank without overriding genuine virality.
//
//   engagement   = likes×3 + comments×5 + saves×4 + streams×1 + BASE(2)
//   decayed      = engagement / (hoursOld + 2)^1.2
//   creatorBoost = 1 + creatorScore × 1.5   → [1.0, 2.5×]
//   typeBoost    = 1 + typeScore × 0.5       → [1.0, 1.5×]
//   genreBoost   = 1 + genreScore × 0.3      → [1.0, 1.3×]
//   followBoost  = 1.5 if user follows creator
//   seenPenalty  = 0.15 if shown in a prior session (7-day window)
//
// BASE(2) ensures a brand-new 0-engagement post always scores above zero and
// competes purely on recency until real engagement accumulates.

const BASE = 2;

export interface ScoredPost {
  id:           string;
  user_id:      string;
  created_at:   string;
  type:         string;
  genre?:       string | null;
  likes?:       { count: number }[];
  comments?:    { count: number }[];
  save_count?:  number;
  stream_count?: number;
  [key: string]: any;
}

export function scorePost(
  post: ScoredPost,
  profile: UserAffinityProfile,
  followingSet: Set<string>,
  seenSet: Set<string>,
  now: number,
): number {
  const likes    = post.likes?.[0]?.count    || 0;
  const comments = post.comments?.[0]?.count || 0;
  const saves    = post.save_count            || 0;
  const streams  = post.stream_count          || 0;
  const hoursOld = (now - new Date(post.created_at).getTime()) / 3_600_000;

  const engagement = likes * 3 + comments * 5 + saves * 4 + streams + BASE;
  const decayed    = engagement / Math.pow(hoursOld + 2, 1.2);

  const creatorBoost = 1.0 + (profile.creatorScores[post.user_id]  ?? 0) * 1.5;
  const typeBoost    = 1.0 + (profile.typeScores[post.type]         ?? 0) * 0.5;
  const genreBoost   = 1.0 + (profile.genreScores[post.genre ?? ''] ?? 0) * 0.3;
  const followMul    = followingSet.has(post.user_id) ? 1.5 : 1.0;
  const seenMul      = seenSet.has(post.id) ? 0.15 : 1.0;

  return decayed * creatorBoost * typeBoost * genreBoost * followMul * seenMul;
}
