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

// Affinity score for one genre-rail item. Music genres read from genreScores;
// the content-type tags (Podcasts / Audiobooks) read from typeScores — so a
// content type the user engages with heavily ranks among the genres by relevancy
// instead of being pinned to the end. Both dimensions are normalized to 0–1.
export function railItemScore(item: string, profile: UserAffinityProfile): number {
  switch (item.toLowerCase()) {
    case 'podcasts':   return profile.typeScores['podcast']   ?? 0;
    case 'audiobooks': return profile.typeScores['audiobook'] ?? 0;
    default:           return profile.genreScores[item.toLowerCase()] ?? 0;
  }
}

// Orders the genre rail (music genres + the Podcasts/Audiobooks tags) by how much
// the user has engaged with each, most relevant first — so the single highest-
// relevancy item sits right after "All". Ties keep their incoming order (Array.sort
// is stable in Hermes), so a brand-new user — and the untouched tail for everyone
// else — sees items in the exact order defined in lib/genres.ts. Shared by the
// Music Discover and Explore genre bars so they order identically.
export function sortRailByAffinity(items: string[], profile: UserAffinityProfile): string[] {
  return [...items].sort((a, b) => railItemScore(b, profile) - railItemScore(a, profile));
}

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
//   engagement   = likes×3 + comments×5 + saves×4 + reposts×6 + streams×1 + BASE(2)
//   decayed      = engagement / (hoursOld + 2)^1.2
//
// Reposts carry the most weight per action — putting a post on your own profile
// is the strongest public endorsement a user can give.
//   creatorBoost = 1 + creatorScore × 1.5   → [1.0, 2.5×]
//   typeBoost    = 1 + typeScore × 0.5       → [1.0, 1.5×]
//   genreBoost   = 1 + genreScore × 0.3      → [1.0, 1.3×]
//   followBoost  = 1.5 if user follows creator
//   badgeBoost   = creator's earned badge tier: bronze 1.02 / silver 1.05 /
//                  gold 1.08 / diamond 1.12 — deliberately subtle, a nudge
//                  that rewards earned status without ever outranking real
//                  engagement (Spotlight launches just above it at 1.15×).
//   seenPenalty  = 0.15 if shown in a prior session (7-day window)
//
// BASE(2) ensures a brand-new 0-engagement post always scores above zero and
// competes purely on recency until real engagement accumulates.

const BASE = 2;

// Earned tier (profiles.badge_tier, cached by the badge evaluator) → score
// multiplier. Missing/unknown tier → 1.0, so this is a no-op for posts whose
// query didn't embed the profile.
export const BADGE_SCORE_BOOST: Record<string, number> = {
  bronze: 1.02, silver: 1.05, gold: 1.08, diamond: 1.12,
};

// ── Originality demotion ─────────────────────────────────────────────────────
// Community Guidelines §7 "Originality and reposting" is deliberately written as
// a DISTRIBUTION rule, not a removal one: a flagged post stays up and stays
// reachable from its author's profile, search and direct links — it is simply
// recommended less. This multiplier is that sentence in code.
//
// Set by a moderator via admin_set_originality (supabase/sql/originality.sql);
// posts.originality_limited rides along on the feed's `select *`. 0.3 matches
// GIRL_SPACE_MAN_PENALTY below on purpose: both are "soft down-rank, still
// discoverable", and having one house value for that keeps the two comparable.
// Tune here — it is the single knob for how hard the policy bites.
export const ORIGINALITY_LIMIT_MUL = 0.3;

export interface ScoredPost {
  id:           string;
  user_id:      string;
  created_at:   string;
  type:         string;
  genre?:       string | null;
  originality_limited?: boolean;
  likes?:       { count: number }[];
  comments?:    { count: number }[];
  save_count?:  number;
  repost_count?: number;
  stream_count?: number;
  [key: string]: any;
}

// ── "Girl space" gender de-prioritization ────────────────────────────────────
// Feminine-tagged (Laybell "Girl space") community posts are SOFTLY down-ranked
// for men — still discoverable, just lower — UNLESS the man already shows interest
// (follows the creator, or has real creator affinity), which lifts the penalty so
// engagement gradually opens the content up. Women / non-binary / unspecified
// viewers are never affected.
export const GIRL_SPACE_MAN_PENALTY = 0.3;
const GIRL_SPACE_INTEREST_AFFINITY = 0.2;
function isMan(gender?: string | null): boolean {
  const g = (gender ?? '').toLowerCase();
  return g === 'man' || g === 'male';
}

export type ScoreOpts = {
  viewerGender?: string | null;
  girlSpaceIds?: Set<string>; // official "Girl space" community ids
};

export function scorePost(
  post: ScoredPost,
  profile: UserAffinityProfile,
  followingSet: Set<string>,
  seenSet: Set<string>,
  now: number,
  opts?: ScoreOpts,
): number {
  const likes    = post.likes?.[0]?.count    || 0;
  const comments = post.comments?.[0]?.count || 0;
  const saves    = post.save_count            || 0;
  const reposts  = post.repost_count          || 0;
  const streams  = post.stream_count          || 0;
  const hoursOld = (now - new Date(post.created_at).getTime()) / 3_600_000;

  const engagement = likes * 3 + comments * 5 + saves * 4 + reposts * 6 + streams + BASE;
  const decayed    = engagement / Math.pow(hoursOld + 2, 1.2);

  const creatorBoost = 1.0 + (profile.creatorScores[post.user_id]  ?? 0) * 1.5;
  const typeBoost    = 1.0 + (profile.typeScores[post.type]         ?? 0) * 0.5;
  const genreBoost   = 1.0 + (profile.genreScores[post.genre ?? ''] ?? 0) * 0.3;
  const followMul    = followingSet.has(post.user_id) ? 1.5 : 1.0;
  const badgeMul     = BADGE_SCORE_BOOST[post.profiles?.badge_tier ?? ''] ?? 1.0;
  const seenMul      = seenSet.has(post.id) ? 0.15 : 1.0;
  const origMul      = post.originality_limited ? ORIGINALITY_LIMIT_MUL : 1.0;

  // Girl space: down-rank feminine-tagged posts for uninterested men (see above).
  let girlSpaceMul = 1.0;
  const gs = opts?.girlSpaceIds;
  if (gs && gs.size && isMan(opts?.viewerGender)) {
    const cids: string[] = post.community_ids ?? [];
    if (cids.some((id) => gs.has(id))) {
      const interested =
        followingSet.has(post.user_id) ||
        (profile.creatorScores[post.user_id] ?? 0) >= GIRL_SPACE_INTEREST_AFFINITY;
      if (!interested) girlSpaceMul = GIRL_SPACE_MAN_PENALTY;
    }
  }

  return decayed * creatorBoost * typeBoost * genreBoost * followMul * badgeMul * seenMul * girlSpaceMul * origMul;
}

// ── Instagram-style feed arrangement ─────────────────────────────────────────
// Current Instagram gives a wholesale-different feed on nearly every refresh —
// not by lightly reordering a fixed set, but by drawing a fresh WEIGHTED-RANDOM
// sample from a large candidate pool each time (quality-tilted, so good posts are
// likelier but nothing is pinned). arrangeFeed approximates that: from the
// fetched pool it draws a new weighted-random ORDER every fetch, so refreshing
// shows a genuinely different arrangement while stronger posts still cluster
// toward the top. It also spreads same-author posts so one creator never clumps
// (an IG hallmark).
//
// The ceiling is CONTENT SUPPLY — with few posts in the pool there's only so much
// "different" possible — so the home query pulls a WIDE pool (see index.tsx).
//
// Runs AFTER the deterministic scorePost and AFTER the spotlight anchors are
// computed (anchors + the seen-penalty stay on the deterministic score), and
// BEFORE the spotlight merge.

// Sampling weight = score^FEED_QUALITY_BIAS. 1.0 = proportional to score (strong
// variety, good posts likelier); higher = steadier/more-quality; lower = more
// chaotic. AUTHOR_SPREAD_DECAY lowers a creator's successive posts' weight so
// they fan out (lower = more aggressive spreading).
export const FEED_QUALITY_BIAS = 1.0;
export const AUTHOR_SPREAD_DECAY = 0.55;

export function arrangeFeed<T extends { item: { user_id?: string }; score: number }>(
  pairs: T[],
  opts?: { qualityBias?: number; authorDecay?: number },
): T[] {
  if (pairs.length < 2) return pairs;
  const qualityBias = opts?.qualityBias ?? FEED_QUALITY_BIAS;
  const authorDecay = opts?.authorDecay ?? AUTHOR_SPREAD_DECAY;

  // Walk best-first to count each author's posts, build a sampling WEIGHT (score
  // with a per-author decay), then draw a fresh key per post: an Efraimidis–
  // Spirakis-style weighted shuffle — different order every fetch, tilted toward
  // higher weights.
  const byAuthor = new Map<string, number>();
  const shuffled = [...pairs]
    .sort((a, b) => b.score - a.score)
    .map((p) => {
      const uid = p.item.user_id ?? '';
      const n = byAuthor.get(uid) ?? 0;
      byAuthor.set(uid, n + 1);
      const weight = Math.max(p.score, 1e-9) * Math.pow(authorDecay, n);
      return { pair: p, key: Math.pow(weight, qualityBias) * Math.random() };
    })
    .sort((a, b) => b.key - a.key);

  // Reassign scores to the pool's own sorted distribution so the ORDER is the
  // weighted shuffle while magnitudes stay in the normal range the spotlight
  // anchors/merge expect (raw keys are tiny — every spotlight would outrank them).
  const desc = pairs.map((p) => p.score).sort((a, b) => b - a);
  return shuffled.map((s, i) => ({ ...s.pair, score: desc[i] }));
}
