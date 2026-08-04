import { supabase } from './supabase';
import { bumpBadge } from './badges';
import { createNotification } from './createNotification';

// Liking a SONG from outside the app's own UI — specifically the heart on the
// iOS lock screen / Control Center card (see lib/trackPlayerService).
//
// Deliberately standalone rather than reaching into NowPlaying's handleLike:
// that one also drives React state and the stats cache, neither of which exists
// when the press arrives from the lock screen. This is the database half only,
// so the two paths write identical rows and fire the same badge + notification.
//
// Naming mirrors lib/stories.ts (fetchStoryLiked / setStoryLike), which solves
// the same problem for stories.

// ── Cross-surface sync ───────────────────────────────────────────────────────
// A song's like state is shown in two places that don't share a render tree:
// the in-app player (NowPlaying, with its own state + stats cache) and the iOS
// lock-screen heart. Whichever one is pressed, the other has to follow, or the
// two disagree until the track changes.
//
// A tiny module-level pub/sub rather than context, matching the narrow selector
// stores already used for audio state: the lock-screen handler lives outside
// React entirely, so there is no provider it could read from.
//
// Events carry the ABSOLUTE state, never a toggle. That makes them idempotent,
// so a surface receiving the echo of its own press just no-ops instead of
// flipping back.
type SongLikeEvent = { postId: string; liked: boolean };
const likeListeners = new Set<(e: SongLikeEvent) => void>();

export function subscribeSongLike(cb: (e: SongLikeEvent) => void): () => void {
  likeListeners.add(cb);
  return () => { likeListeners.delete(cb); };
}

/** Announce a like state that has been applied (or optimistically painted). */
export function publishSongLike(postId: string, liked: boolean): void {
  for (const cb of likeListeners) { try { cb({ postId, liked }); } catch {} }
}

/** Whether `userId` has already liked `postId`. False on any failure — a like
 *  button that defaults to "not liked" is recoverable; one that wrongly shows
 *  liked makes the user think their tap did nothing. */
export async function fetchSongLiked(postId: string, userId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('likes')
      .select('post_id')
      .eq('user_id', userId)
      .eq('post_id', postId)
      .maybeSingle();
    if (error) return false;
    return !!data;
  } catch {
    return false;
  }
}

/**
 * Apply a like/unlike. Returns the state actually reached, so a caller can
 * repaint from the truth rather than from its optimistic guess — the lock
 * screen has no way to show an error, so a failed toggle must simply leave the
 * heart where it was.
 */
export async function setSongLike(
  postId: string,
  userId: string,
  liked: boolean,
  ownerId?: string | null,
): Promise<boolean> {
  try {
    if (liked) {
      const { error } = await supabase.from('likes').insert({ user_id: userId, post_id: postId });
      // 23505 = already liked (a double-press, or the in-app heart got there
      // first). The desired state is reached either way, so treat it as success.
      if (error && (error as any).code !== '23505') return !liked;
      bumpBadge('likes');
      if (ownerId && ownerId !== userId) {
        createNotification({ userId: ownerId, actorId: userId, type: 'like', postId });
      }
    } else {
      const { error } = await supabase
        .from('likes')
        .delete()
        .eq('user_id', userId)
        .eq('post_id', postId);
      if (error) return !liked;
    }
    // Announce the state that actually landed, so every surface converges on
    // the truth even if a caller's optimistic paint guessed wrong.
    publishSongLike(postId, liked);
    return liked;
  } catch {
    publishSongLike(postId, !liked);
    return !liked;
  }
}
