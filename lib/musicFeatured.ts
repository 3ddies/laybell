import { supabase } from './supabase';
import { type Album, albumCover } from './albums';

// The Music tab's "Featured" card (Premium perk) — up to four things the artist
// wants heard first, shown one at a time on a slow rotation at the top of the
// tab. A pick is a SONG or an ALBUM: a record is as much a thing to lead with as
// a single, and forcing the choice to be track-shaped would mean an artist with
// a new album could only point at one song from it.
//
// This replaced whole-catalogue ordering, and the reason is worth keeping: an
// order is work that never ends — every new song reopens the question of where
// it goes — and a visitor cannot tell a deliberate order from a default one.
// Four picks are a statement anyone can read at a glance, and adding a song does
// not disturb them.
//
// STORAGE is a jsonb array of strings on profiles.music_featured, each one
// "song:<id>" or "album:<id>". A BARE id is read as a song, which is what the
// column held before albums could be picked — nothing in production ever had a
// value, but the fallback costs one line and means no row can be misread.
//
// Editing is Premium-gated in the UI; READING is open, because the whole point
// is that visitors see it.

export const MAX_FEATURED = 4;

export type FeaturedKind = 'song' | 'album';
export type FeaturedRef = { kind: FeaturedKind; id: string };

/** A pick resolved against what is actually on the profile, ready to render. */
export type FeaturedItem = {
  key: string;
  kind: FeaturedKind;
  id: string;
  title: string;
  cover: string | null;
  /** Playback source — songs only. An album opens its screen instead. */
  uri?: string | null;
};

export const refKey = (r: FeaturedRef) => `${r.kind}:${r.id}`;

/**
 * Coerce a stored value into refs. jsonb arrives as an array on some client
 * paths and a JSON string on others, and a row written before this column
 * existed arrives as null — all three have to mean "nothing featured".
 */
export function parseFeatured(raw: any): FeaturedRef[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? (() => { try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; } })()
      : [];
  const out: FeaturedRef[] = [];
  const seen = new Set<string>();
  for (const v of list) {
    if (typeof v !== 'string' || !v) continue;
    const i = v.indexOf(':');
    const kind: FeaturedKind = i > 0 && v.slice(0, i) === 'album' ? 'album' : 'song';
    const id = i > 0 ? v.slice(i + 1) : v;
    const k = `${kind}:${id}`;
    if (!id || seen.has(k)) continue;
    seen.add(k);
    out.push({ kind, id });
    if (out.length >= MAX_FEATURED) break;
  }
  return out;
}

/**
 * Resolve refs against the profile's actual songs and albums, in pinned order.
 * Anything that no longer resolves — deleted, archived, made private, album
 * removed — is skipped rather than left as a hole, so a stale list degrades to a
 * shorter rotation instead of a blank card in the middle of it.
 */
export function resolveFeatured(
  raw: any,
  tracks: readonly any[],
  albums: readonly Album[],
): FeaturedItem[] {
  const refs = parseFeatured(raw);
  if (refs.length === 0) return [];
  const trackById = new Map(tracks.map((t: any) => [t.id, t]));
  const albumById = new Map(albums.map((a) => [a.id, a]));
  const out: FeaturedItem[] = [];
  for (const r of refs) {
    if (r.kind === 'album') {
      const a = albumById.get(r.id);
      if (a) out.push({ key: refKey(r), kind: 'album', id: a.id, title: a.title, cover: albumCover(a) });
    } else {
      const t = trackById.get(r.id);
      if (t) out.push({ key: refKey(r), kind: 'song', id: t.id, title: t.caption ?? '', cover: t.cover_url ?? null, uri: t.media_url });
    }
  }
  return out;
}

/** Persist the current user's picks. Capped here as well as in the UI. */
export async function saveFeatured(refs: FeaturedRef[]): Promise<boolean> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;
    const { error } = await supabase
      .from('profiles')
      .update({ music_featured: refs.slice(0, MAX_FEATURED).map(refKey) })
      .eq('id', user.id);
    return !error;
  } catch { return false; }
}
