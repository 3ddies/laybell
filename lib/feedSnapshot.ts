import AsyncStorage from '@react-native-async-storage/async-storage';
import { snapshotHead } from './feedMerge';

// The Home feed's first screen, kept on the phone so a cold start paints real posts
// at once instead of a skeleton while the fresh feed loads (1.0.4 — Instagram opens
// on what you last saw). Organic posts only (feedMerge.snapshotHead). Per account, so
// switching accounts never shows the previous one's feed. The fresh feed replaces it
// within a round trip or two; one older than MAX_AGE_MS is dropped rather than shown,
// because by then it misleads (deleted posts, stale counts).

const KEY = (userId: string) => `feed_snapshot_v1_${userId}`;
const SIZE = 12;
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
// Written a beat after the paint it records, so serializing it never competes with
// the first frames of the fresh feed (or its first video starting).
const SAVE_DELAY_MS = 1500;

export type FeedSnapshot<T> = { savedAt: number; posts: T[]; liked: string[]; saved: string[] };

/**
 * How long the fresh feed gets to arrive before last session's screen is shown
 * instead of a skeleton. Long enough that a normal connection never shows a
 * snapshot at all (and so never shows two orders in a row); short enough that a
 * slow one is not left staring at placeholders.
 */
export const SNAPSHOT_AFTER_MS = 400;

export async function loadFeedSnapshot<T>(userId: string): Promise<FeedSnapshot<T> | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY(userId));
    if (!raw) return null;
    const snap = JSON.parse(raw) as FeedSnapshot<T>;
    if (!Array.isArray(snap?.posts) || snap.posts.length === 0) return null;
    if (!(Date.now() - snap.savedAt < MAX_AGE_MS)) return null;
    return {
      savedAt: snap.savedAt,
      posts: snap.posts,
      liked: Array.isArray(snap.liked) ? snap.liked : [],
      saved: Array.isArray(snap.saved) ? snap.saved : [],
    };
  } catch {
    return null;
  }
}

export function saveFeedSnapshot(
  userId: string,
  feed: { id: string; __ad?: unknown; __spotlight?: unknown }[],
  liked: Set<string> | null,
  saved: Set<string> | null,
): void {
  const posts = snapshotHead(feed, SIZE);
  if (posts.length === 0) return;
  const ids = new Set(posts.map((p) => p.id));
  const snap: FeedSnapshot<unknown> = {
    savedAt: Date.now(),
    posts,
    liked: liked ? [...liked].filter((id) => ids.has(id)) : [],
    saved: saved ? [...saved].filter((id) => ids.has(id)) : [],
  };
  setTimeout(() => {
    AsyncStorage.setItem(KEY(userId), JSON.stringify(snap)).catch(() => {});
  }, SAVE_DELAY_MS);
}

export async function clearFeedSnapshot(userId: string): Promise<void> {
  try { await AsyncStorage.removeItem(KEY(userId)); } catch {}
}
