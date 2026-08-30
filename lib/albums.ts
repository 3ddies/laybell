import { supabase } from './supabase';

// Albums — an artist's own tracks, gathered and ordered by them.
//
// The distinction from a playlist is worth stating once, because it decides
// almost everything else: a playlist is a LISTENER'S collection of anyone's
// music and lives on the Music tab to be discovered; an album is an ARTIST'S
// statement about their own work and lives on their profile. Ownership and
// audio-only are enforced by a trigger in supabase/sql/albums.sql rather than
// here, so the rule holds for every path including the ones not written yet.
//
// The per-track `title` override is the other load-bearing idea. Fixing a
// spelling inside an album must not rewrite the published post's caption — that
// post is already out there and may be sitting in someone's playlist — so the
// album carries its own name for the track and falls back to the caption.

export type AlbumTrack = {
  post_id: string;
  position: number;
  /** Album-local name. Null → fall back to the post's caption. */
  title: string | null;
  post?: {
    id: string;
    caption: string | null;
    media_url: string;
    cover_url: string | null;
    duration_seconds: number | null;
    stream_count: number | null;
    created_at: string;
  } | null;
};

export type Album = {
  id: string;
  user_id: string;
  title: string;
  cover_url: string | null;
  created_at: string;
  updated_at: string;
  tracks?: AlbumTrack[];
  /** Present on list queries; the album screen counts its own rows. */
  track_count?: number;
};

/** What a track is called HERE: the album's name for it, else the post's. */
export function trackTitle(t: AlbumTrack): string {
  const own = t.title?.trim();
  if (own) return own;
  return t.post?.caption?.trim() || '';
}

/**
 * The album's face. An explicit cover wins; otherwise the first track's artwork
 * stands in, so an album always has one without making the artist produce a
 * second image for something they have already illustrated.
 */
export function albumCover(a: Album): string | null {
  if (a.cover_url) return a.cover_url;
  const first = (a.tracks ?? []).find((t) => t.post?.cover_url);
  return first?.post?.cover_url ?? null;
}

/** A user's albums, newest first, each with enough tracks to draw a cover. */
export async function fetchAlbums(userId: string): Promise<Album[]> {
  const { data, error } = await supabase
    .from('albums')
    .select('*, album_tracks(post_id, position, title, posts(id, cover_url))')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row: any) => {
    const rows = (row.album_tracks ?? []) as any[];
    return {
      ...row,
      track_count: rows.length,
      tracks: rows
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((t) => ({ post_id: t.post_id, position: t.position, title: t.title, post: t.posts })),
    } as Album;
  });
}

/** One album with its full track rows, ordered. */
export async function fetchAlbum(albumId: string): Promise<Album | null> {
  const { data, error } = await supabase
    .from('albums')
    .select(`
      *,
      album_tracks(
        post_id, position, title,
        posts(id, caption, media_url, cover_url, duration_seconds, stream_count, created_at)
      )
    `)
    .eq('id', albumId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const rows = ((data as any).album_tracks ?? []) as any[];
  return {
    ...(data as any),
    track_count: rows.length,
    tracks: rows
      .slice()
      .sort((a, b) => a.position - b.position)
      // A track whose post has been deleted, archived or made private drops out
      // for this viewer — posts' own RLS decides that, and the join simply
      // returns null. Filtering here means every consumer gets a list it can
      // render rather than a hole it has to remember to check for.
      .filter((t) => t.posts)
      .map((t) => ({ post_id: t.post_id, position: t.position, title: t.title, post: t.posts })),
  } as Album;
}

export async function createAlbum(userId: string, title: string): Promise<Album> {
  const { data, error } = await supabase
    .from('albums')
    .insert({ user_id: userId, title: title.trim().slice(0, 120) })
    .select()
    .single();
  if (error) throw error;
  return data as Album;
}

export async function renameAlbum(albumId: string, title: string): Promise<void> {
  const { error } = await supabase
    .from('albums')
    .update({ title: title.trim().slice(0, 120), updated_at: new Date().toISOString() })
    .eq('id', albumId);
  if (error) throw error;
}

export async function setAlbumCover(albumId: string, coverUrl: string | null): Promise<void> {
  const { error } = await supabase
    .from('albums')
    .update({ cover_url: coverUrl, updated_at: new Date().toISOString() })
    .eq('id', albumId);
  if (error) throw error;
}

export async function deleteAlbum(albumId: string): Promise<void> {
  const { error } = await supabase.from('albums').delete().eq('id', albumId);
  if (error) throw error;
}

/**
 * Add a track to the end. Idempotent by primary key, so publishing into an
 * album twice — a retry, a double tap on Post — cannot duplicate the row.
 */
export async function addTrack(albumId: string, postId: string, title?: string | null): Promise<void> {
  const { data } = await supabase
    .from('album_tracks')
    .select('position')
    .eq('album_id', albumId)
    .order('position', { ascending: false })
    .limit(1);
  const next = ((data?.[0] as any)?.position ?? -1) + 1;
  const { error } = await supabase
    .from('album_tracks')
    .upsert(
      { album_id: albumId, post_id: postId, position: next, title: title?.trim() || null },
      { onConflict: 'album_id,post_id', ignoreDuplicates: true },
    );
  if (error) throw error;
}

export async function removeTrack(albumId: string, postId: string): Promise<void> {
  const { error } = await supabase
    .from('album_tracks')
    .delete()
    .eq('album_id', albumId)
    .eq('post_id', postId);
  if (error) throw error;
}

export async function renameTrack(albumId: string, postId: string, title: string | null): Promise<void> {
  const { error } = await supabase
    .from('album_tracks')
    .update({ title: title?.trim() || null })
    .eq('album_id', albumId)
    .eq('post_id', postId);
  if (error) throw error;
}

/**
 * Persist a new order. Takes the FULL ordered list of post ids and rewrites
 * every position, rather than trying to patch the two rows a move touched:
 * positions are only meaningful relative to each other, and a partial rewrite
 * interrupted halfway leaves an order that is wrong in a way nothing detects.
 */
export async function reorderTracks(albumId: string, postIds: string[]): Promise<void> {
  await Promise.all(
    postIds.map((postId, i) =>
      supabase.from('album_tracks').update({ position: i }).eq('album_id', albumId).eq('post_id', postId),
    ),
  );
}

/**
 * The owner's audio posts that are NOT yet on this album — what the add-tracks
 * picker offers. Archived posts are excluded: an album is a shelf of things
 * people can play, and an archived song is not one of them.
 */
export async function fetchAddableTracks(userId: string, albumId: string): Promise<any[]> {
  const [{ data: mine }, { data: on }] = await Promise.all([
    supabase
      .from('posts')
      .select('id, caption, cover_url, duration_seconds, created_at, archived_at')
      .eq('user_id', userId)
      .eq('type', 'audio')
      .order('created_at', { ascending: false })
      .limit(300),
    supabase.from('album_tracks').select('post_id').eq('album_id', albumId),
  ]);
  const taken = new Set((on ?? []).map((r: any) => r.post_id));
  return (mine ?? []).filter((p: any) => !p.archived_at && !taken.has(p.id));
}
