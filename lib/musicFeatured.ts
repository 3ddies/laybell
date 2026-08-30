import { supabase } from './supabase';

// The Music tab's "Featured" rail (Premium perk) — up to four of the owner's own
// songs, pinned to the top of the tab. Stored as a jsonb array of post ids on
// profiles.music_featured (see supabase/sql/music_featured.sql).
//
// This replaced whole-catalogue ordering, and the reason is worth keeping: an
// order is work that never ends — every new song reopens the question of where
// it goes — and a visitor cannot tell a deliberate order from a default one.
// Four pinned songs are a statement anyone can read at a glance, and adding a
// song does not disturb them.
//
// Editing is Premium-gated in the UI; READING is open, because the whole point
// is that visitors see it.

export const MAX_FEATURED = 4;

/**
 * Coerce a stored value into a clean id list. jsonb arrives as an array on some
 * client paths and as a JSON string on others, and a row written before this
 * column existed arrives as null — all three have to mean "no rail".
 */
export function parseFeatured(raw: any): string[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? (() => { try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; } })()
      : [];
  return list.filter((x: any): x is string => typeof x === 'string').slice(0, MAX_FEATURED);
}

/**
 * Resolve the ids against the tracks actually on the profile, in the pinned
 * order. Ids that no longer resolve — deleted, archived, made private — are
 * skipped rather than left as holes, so a stale list degrades to a shorter rail.
 */
export function featuredTracks<T extends { id: string }>(tracks: T[], raw: any): T[] {
  const ids = parseFeatured(raw);
  if (ids.length === 0) return [];
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const out: T[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const t = byId.get(id);
    if (t && !seen.has(id)) { out.push(t); seen.add(id); }
  }
  return out;
}

/** Persist the current user's picks. Capped here as well as in the UI. */
export async function saveFeatured(ids: string[]): Promise<boolean> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;
    const { error } = await supabase
      .from('profiles')
      .update({ music_featured: ids.slice(0, MAX_FEATURED) })
      .eq('id', user.id);
    return !error;
  } catch { return false; }
}
