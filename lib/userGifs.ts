// Laybell GIF library — a user's saved + created GIFs. See user_gifs.sql.
import { supabase } from './supabase';

export type UserGif = { id: string; url: string; w: number; h: number; kind: 'saved' | 'created'; sourcePostId?: string };

// A user's library, newest first. Returns [] pre-migration (missing table).
export async function fetchUserGifs(userId: string): Promise<UserGif[]> {
  const { data } = await supabase
    .from('user_gifs').select('id, url, w, h, kind, source_post_id')
    .eq('user_id', userId).order('created_at', { ascending: false });
  return (data ?? []).map((r: any) => ({
    id: r.id, url: r.url, w: r.w, h: r.h, kind: r.kind, sourcePostId: r.source_post_id ?? undefined,
  })) as UserGif[];
}

// Add a GIF to the library (upsert on user_id+url so re-saving is a no-op).
// Returns null on success, or the DB error message (e.g. table not migrated yet).
export async function addUserGif(
  userId: string, gif: { url: string; w?: number; h?: number; kind: 'saved' | 'created'; sourcePostId?: string },
): Promise<string | null> {
  const { error } = await supabase
    .from('user_gifs')
    .upsert(
      { user_id: userId, url: gif.url, w: gif.w ?? null, h: gif.h ?? null, kind: gif.kind, source_post_id: gif.sourcePostId ?? null },
      { onConflict: 'user_id,url' },
    );
  return error ? (error.message || 'error') : null;
}

export async function removeUserGif(id: string): Promise<void> {
  await supabase.from('user_gifs').delete().eq('id', id);
}
