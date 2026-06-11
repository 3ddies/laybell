import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { fetchBlockedIds } from './blocks';
import { readContactHashes } from './contacts';

// "Suggested for you" account recommendations. Three blind signals are merged,
// de-duped, and ranked: contacts (you have each other's number/email) > mutual
// follows (people your followings also follow) > nearby (approximate location).
// Every signal is independently guarded so a missing RPC/table (pre-migration)
// just drops that signal instead of failing the whole set.

export type SuggestionReason = 'contacts' | 'mutual' | 'nearby' | 'popular';

export type SuggestedAccount = {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  badge_tier: string | null;
  badge_show: boolean | null;
  reason: SuggestionReason;
  score: number; // higher = more strongly recommended (drives ordering + rotation)
};

export const REASON_LABEL: Record<SuggestionReason, string> = {
  contacts: 'From your contacts',
  mutual: 'Followed by people you follow',
  nearby: 'In your area',
  popular: 'Popular on Laybell',
};

const PROFILE_COLS = 'id, username, display_name, avatar_url, badge_tier, badge_show, profile_theme';
const HASH_BATCH = 500;

// Backfill so discovery is never empty even with zero contacts/location/mutual
// signals (and before the recommendation SQL is applied). "Popular" = most-followed
// from a sampled tally of the follows table (no aggregation SQL needed), falling
// back to the newest accounts if there are no follows yet. Scores stay below the
// nearby floor (1000) so any real signal always ranks above these.
async function fetchPopularProfiles(exclude: Set<string>, need: number): Promise<SuggestedAccount[]> {
  if (need <= 0) return [];
  const ranked: string[] = [];
  const seen = new Set<string>(exclude);

  try {
    const { data } = await supabase.from('follows').select('following_id').limit(1000);
    const tally = new Map<string, number>();
    for (const r of data ?? []) {
      const id = r.following_id as string;
      if (!seen.has(id)) tally.set(id, (tally.get(id) ?? 0) + 1);
    }
    for (const [id] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
      ranked.push(id); seen.add(id);
    }
  } catch {}

  // Top up with the newest accounts if the follow tally didn't yield enough.
  if (ranked.length < need) {
    try {
      const { data } = await supabase.from('profiles').select('id')
        .order('created_at', { ascending: false }).limit(need * 3 + 20);
      for (const p of data ?? []) {
        const id = p.id as string;
        if (!seen.has(id)) { ranked.push(id); seen.add(id); }
      }
    } catch {}
  }

  const ids = ranked.slice(0, need);
  if (!ids.length) return [];

  const { data } = await supabase.from('profiles').select(PROFILE_COLS).in('id', ids);
  const byId = new Map<string, any>((data ?? []).map((p: any) => [p.id, p]));
  const out: SuggestedAccount[] = [];
  ids.forEach((id, i) => {
    const p = byId.get(id);
    if (!p) return;
    out.push({
      id: p.id, username: p.username, display_name: p.display_name,
      avatar_url: p.avatar_url ?? null, badge_tier: p.badge_tier ?? null,
      badge_show: p.badge_show ?? null, reason: 'popular', score: 900 - i,
    });
  });
  return out;
}

export async function fetchSuggestedAccounts(
  userId: string,
  opts: { contactHashes?: string[]; max?: number } = {},
): Promise<SuggestedAccount[]> {
  const max = opts.max ?? 20;

  // Who I already follow + who I've blocked + my own coarse location.
  const [followingRes, blocked, myProfileRes] = await Promise.all([
    supabase.from('follows').select('following_id').eq('follower_id', userId),
    fetchBlockedIds(),
    supabase.from('profiles').select('latitude, longitude, location_enabled').eq('id', userId).maybeSingle(),
  ]);
  const following = new Set((followingRes.data ?? []).map((f: any) => f.following_id as string));
  const exclude = new Set<string>([userId, ...following, ...blocked]);
  const myProfile: any = myProfileRes.data ?? {};

  // --- Signal 1: contacts (hashed) ---
  const contactIds = new Set<string>();
  if (opts.contactHashes && opts.contactHashes.length) {
    try {
      for (let i = 0; i < opts.contactHashes.length; i += HASH_BATCH) {
        const batch = opts.contactHashes.slice(i, i + HASH_BATCH);
        const { data } = await supabase.rpc('match_contacts', { hashes: batch });
        for (const row of data ?? []) {
          const id = row.user_id as string;
          if (!exclude.has(id)) contactIds.add(id);
        }
      }
    } catch {}
  }

  // --- Signal 2: mutual follows (2nd degree) ---
  const mutualCount = new Map<string, number>();
  const seed = [...following].slice(0, 200);
  if (seed.length) {
    try {
      const { data } = await supabase.from('follows').select('following_id').in('follower_id', seed);
      for (const row of data ?? []) {
        const id = row.following_id as string;
        if (exclude.has(id)) continue;
        mutualCount.set(id, (mutualCount.get(id) ?? 0) + 1);
      }
    } catch {}
  }

  // --- Signal 3: nearby (approximate location) ---
  const nearby = new Map<string, { row: any; distance: number }>();
  if (myProfile.location_enabled && myProfile.latitude != null && myProfile.longitude != null) {
    try {
      const { data } = await supabase.rpc('nearby_profiles', {
        p_lat: myProfile.latitude, p_lng: myProfile.longitude, p_limit: 40,
      });
      for (const row of data ?? []) {
        const id = row.id as string;
        if (!exclude.has(id)) nearby.set(id, { row, distance: row.distance_km ?? 0 });
      }
    } catch {}
  }

  // Candidate ids = union of all signals. Reason = highest-priority signal present.
  const ids = new Set<string>([...contactIds, ...mutualCount.keys(), ...nearby.keys()]);
  if (ids.size === 0) return [];

  const reasonOf = (id: string): SuggestionReason =>
    contactIds.has(id) ? 'contacts' : mutualCount.has(id) ? 'mutual' : 'nearby';

  // Numeric score so ordering and rotation are stable: contacts > mutual > nearby,
  // with mutual broken by shared-follow count and nearby by closeness.
  const scoreOf = (id: string, reason: SuggestionReason): number => {
    if (reason === 'contacts') return 3000;
    if (reason === 'mutual') return 2000 + Math.min(mutualCount.get(id) ?? 0, 999);
    return 1000 + Math.max(0, 500 - (nearby.get(id)?.distance ?? 500)); // nearby
  };

  // Profile rows: nearby already returns them; fetch the rest in one query.
  const byId = new Map<string, any>();
  for (const [id, n] of nearby) byId.set(id, n.row);
  const needFetch = [...ids].filter((id) => !byId.has(id));
  if (needFetch.length) {
    try {
      const { data } = await supabase.from('profiles').select(PROFILE_COLS).in('id', needFetch);
      for (const p of data ?? []) byId.set(p.id, p);
    } catch {}
  }

  const out: SuggestedAccount[] = [];
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) continue;
    const reason = reasonOf(id);
    out.push({
      id: p.id, username: p.username, display_name: p.display_name,
      avatar_url: p.avatar_url ?? null, badge_tier: p.badge_tier ?? null,
      badge_show: p.badge_show ?? null, reason, score: scoreOf(id, reason),
    });
  }

  out.sort((a, b) => b.score - a.score);

  // Never return an empty (or thin) set: backfill with popular accounts. Real
  // signals keep their higher scores, so popular fills only the remaining slots.
  if (out.length < max) {
    const have = new Set<string>([...exclude, ...out.map(o => o.id)]);
    out.push(...await fetchPopularProfiles(have, max - out.length));
  }

  return out.slice(0, max);
}

// ---------------------------------------------------------------------------
// Rotating discovery feed (Friends screen). Keeps the strongest recommendations
// pinned for a few days, then rotates: the top 40% stay, the bottom 60% are
// swapped out for fresh picks. Ordering always reflects the current metric score.
// ---------------------------------------------------------------------------

const ROTATE_MS = 3 * 24 * 60 * 60 * 1000; // auto-refresh window: 3 days
const FEED_SIZE = 30;                       // how many to surface
const KEEP_FRAC = 0.4;                      // top 40% survive a rotation

type FeedCache = { refreshedAt: number; items: SuggestedAccount[] };
const feedKey = (userId: string) => `laybell.suggestFeed.${userId}`;

async function readFeedCache(userId: string): Promise<FeedCache | null> {
  try { const raw = await AsyncStorage.getItem(feedKey(userId)); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
}
async function writeFeedCache(userId: string, cache: FeedCache): Promise<void> {
  try { await AsyncStorage.setItem(feedKey(userId), JSON.stringify(cache)); } catch {}
}

// Read the device contact hashes only if the user opted into contacts. Shared by
// the Friends screen and the Explore rail.
export async function loadContactHashesIfEnabled(userId: string): Promise<string[]> {
  try {
    const { data } = await supabase.from('profiles').select('contacts_enabled').eq('id', userId).maybeSingle();
    if (data?.contacts_enabled) return await readContactHashes();
  } catch {}
  return [];
}

export async function getRotatingSuggestions(
  userId: string,
  opts: { contactHashes?: string[] } = {},
): Promise<SuggestedAccount[]> {
  // Fresh, fully-ranked pool from the live metrics (bigger than we display so a
  // rotation has new candidates to draw from).
  let pool: SuggestedAccount[] = [];
  try { pool = await fetchSuggestedAccounts(userId, { ...opts, max: 80 }); } catch {}
  const poolById = new Map(pool.map(p => [p.id, p]));

  // Anyone now followed/blocked is dropped from a stale cache.
  const exclude = new Set<string>([userId]);
  try {
    const [f, b] = await Promise.all([
      supabase.from('follows').select('following_id').eq('follower_id', userId),
      fetchBlockedIds(),
    ]);
    for (const r of f.data ?? []) exclude.add(r.following_id);
    for (const id of b) exclude.add(id);
  } catch {}
  const valid = (a: SuggestedAccount) => !exclude.has(a.id);
  const hydrate = (a: SuggestedAccount) => poolById.get(a.id) ?? a; // refresh score/reason if still live

  const now = Date.now();
  const cache = await readFeedCache(userId);

  // First run — seed from the top of the fresh pool.
  if (!cache?.items?.length) {
    const seeded = pool.filter(valid).slice(0, FEED_SIZE);
    await writeFeedCache(userId, { refreshedAt: now, items: seeded });
    return seeded;
  }

  const prev = cache.items.filter(valid).map(hydrate);

  // Within the window — keep the set stable, only topping up if follows/blocks
  // shrank it below the target (so the list never dwindles to nothing).
  if (now - cache.refreshedAt < ROTATE_MS) {
    const result = [...prev];
    if (result.length < FEED_SIZE) {
      const have = new Set(result.map(a => a.id));
      for (const p of pool) {
        if (result.length >= FEED_SIZE) break;
        if (!have.has(p.id) && valid(p)) { result.push(p); have.add(p.id); }
      }
      await writeFeedCache(userId, { refreshedAt: cache.refreshedAt, items: result });
    }
    return result;
  }

  // Rotation boundary — keep the top 40%, swap the bottom 60% for fresh picks.
  const keep = prev.slice(0, Math.ceil(FEED_SIZE * KEEP_FRAC));
  const keepIds = new Set(keep.map(a => a.id));
  const fresh: SuggestedAccount[] = [];
  for (const p of pool) {
    if (keep.length + fresh.length >= FEED_SIZE) break;
    if (!keepIds.has(p.id) && valid(p)) fresh.push(p);
  }
  const result = [...keep, ...fresh].sort((a, b) => b.score - a.score);
  await writeFeedCache(userId, { refreshedAt: now, items: result });
  return result;
}
