import { supabase } from './supabase';

// Song "features" — collaborator credits on an audio post. Stored as
// posts.features jsonb (song_features.sql).
//
// A credit is EITHER a Laybell user (id + denormalized display name) OR a plain
// typed name with a null id. Off-platform credits used to be impossible: the
// picker only searched profiles, so the producer who made the beat had to be
// jammed into the song title or go uncredited entirely.
//
// That was backwards for the one thing this app claims to do. The people most
// worth crediting — the producer, the engineer, the writer — are exactly the
// ones least likely to already have an account, and "credit them once they
// join" is a promise about somebody else's behaviour.
//
// A null id means NAMED, NOT LINKED: the name renders, it simply is not
// tappable and opens no profile. Every consumer must handle that, which is what
// featureKey() and the guards at the render sites exist for.

export type Feature = { id: string | null; name: string };

export const MAX_FEATURES = 6;

/** Longest a typed credit may be. A name, not a sentence. */
export const MAX_FEATURE_NAME = 40;

/**
 * Stable identity for a credit — React keys, de-duplication, removal.
 *
 * Laybell users key on their id; typed credits key on the folded name, so
 * "Marcus" entered twice collapses to one. A real user named Marcus and a typed
 * "Marcus" stay separate on purpose: they are different claims, and merging
 * them would silently attribute a stranger's work to an account.
 */
export function featureKey(f: Feature): string {
  return f.id ? `u:${f.id}` : `n:${f.name.trim().toLowerCase()}`;
}

/** Coerce a stored features value into a clean, capped Feature[]. Never throws. */
export function parseFeatures(raw: any): Feature[] {
  let arr = raw;
  if (typeof raw === 'string') { try { arr = JSON.parse(raw); } catch { return []; } }
  if (!Array.isArray(arr)) return [];
  const out: Feature[] = [];
  const seen = new Set<string>();
  for (const f of arr) {
    if (!f || typeof f.name !== 'string') continue;
    const name = f.name.trim().slice(0, MAX_FEATURE_NAME);
    if (!name) continue;
    // id is optional now. Anything that is not a string — null, undefined, or a
    // number from some older write — normalises to null rather than being
    // dropped, so a credit never disappears just because its id is malformed.
    const id = typeof f.id === 'string' && f.id ? f.id : null;
    const key = featureKey({ id, name });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id, name });
    if (out.length >= MAX_FEATURES) break;
  }
  return out;
}

const cache = new Map<string, Feature[]>();

/** The features credited on a song post — cached per session (card display). */
export async function fetchFeatures(postId: string): Promise<Feature[]> {
  if (cache.has(postId)) return cache.get(postId)!;
  try {
    const { data } = await supabase.from('posts').select('features').eq('id', postId).maybeSingle();
    const list = parseFeatures((data as { features?: unknown } | null)?.features);
    cache.set(postId, list);
    return list;
  } catch {
    return [];
  }
}
