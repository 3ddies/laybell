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
    return liked;
  } catch {
    return !liked;
  }
}
