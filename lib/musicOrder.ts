import { supabase } from './supabase';

// Custom Music-tab ordering (Premium perk). The order is a jsonb array of the
// user's audio-post ids stored on profiles.music_order (see music_order.sql).
// Editing is Premium-gated in the UI; applying/reading is open (so a visitor sees
// the owner's arrangement too).

// Coerce a stored music_order value into a clean string[] (jsonb may arrive as an
// array already, or as a JSON string depending on the client path).
export function parseMusicOrder(raw: any): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  if (typeof raw === 'string') {
    try { const a = JSON.parse(raw); return Array.isArray(a) ? a.filter((x: any): x is string => typeof x === 'string') : []; }
    catch { return []; }
  }
  return [];
}

// Apply the custom order to a track list: listed ids first in that exact order,
// then any tracks NOT in the list appended in the order the caller passed them
// (the default newest-first). Deleted/missing ids are skipped, so a stale order
// degrades gracefully. Empty/absent order → the input list unchanged.
export function applyMusicOrder<T extends { id: string }>(tracks: T[], order: string[] | null | undefined): T[] {
  if (!order || order.length === 0) return tracks;
  const byId = new Map(tracks.map(t => [t.id, t]));
  const out: T[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    const t = byId.get(id);
    if (t && !seen.has(id)) { out.push(t); seen.add(id); }
  }
  for (const t of tracks) if (!seen.has(t.id)) out.push(t);
  return out;
}

// Persist the current user's music order (array of their audio-post ids).
export async function saveMusicOrder(ids: string[]): Promise<boolean> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;
    const { error } = await supabase.from('profiles').update({ music_order: ids }).eq('id', user.id);
    return !error;
  } catch { return false; }
}
