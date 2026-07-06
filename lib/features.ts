import { supabase } from './supabase';

// Song "features" — collaborator credits on an audio post. A feature is always
// a Laybell user (id + denormalized display name); non-Laybell collaborators go
// in the song title text instead. Stored as posts.features jsonb (song_features.sql).

export type Feature = { id: string; name: string };

export const MAX_FEATURES = 6;

/** Coerce a stored features value into a clean, capped Feature[]. Never throws. */
export function parseFeatures(raw: any): Feature[] {
  let arr = raw;
  if (typeof raw === 'string') { try { arr = JSON.parse(raw); } catch { return []; } }
  if (!Array.isArray(arr)) return [];
  const out: Feature[] = [];
  const seen = new Set<string>();
  for (const f of arr) {
    if (f && typeof f.id === 'string' && typeof f.name === 'string' && !seen.has(f.id)) {
      seen.add(f.id);
      out.push({ id: f.id, name: f.name });
      if (out.length >= MAX_FEATURES) break;
    }
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
