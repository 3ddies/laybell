import AsyncStorage from '@react-native-async-storage/async-storage';

// Per-category notification toggles, persisted locally. The Settings screen reads
// and writes these; useNotifications loads them into an in-memory cache so the
// foreground notification handler can decide (synchronously) whether to show a
// banner / play a sound for an incoming push, based on its `data.type`.
//
// NOTE: this gates FOREGROUND presentation locally. Server-side push delivery
// (the send-push Edge Function) is not gated by these prefs yet — a later pass
// could store them server-side and have the function honour them.

export type NotifCategory = 'likes' | 'comments' | 'follows' | 'messages';

export type NotifPrefs = Record<NotifCategory, boolean>;

export const NOTIF_CATEGORIES: NotifCategory[] = ['likes', 'comments', 'follows', 'messages'];

const DEFAULT_PREFS: NotifPrefs = {
  likes: true,
  comments: true,
  follows: true,
  messages: true,
};

const STORAGE_KEY = 'notif_prefs_v1';

// Synchronous cache for the notification handler. Seeded with defaults and kept
// fresh by loadNotifPrefs() / saveNotifPrefs().
let cache: NotifPrefs = { ...DEFAULT_PREFS };

export function getCachedNotifPrefs(): NotifPrefs {
  return cache;
}

export async function loadNotifPrefs(): Promise<NotifPrefs> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      cache = { ...DEFAULT_PREFS, ...parsed };
    } else {
      cache = { ...DEFAULT_PREFS };
    }
  } catch {
    cache = { ...DEFAULT_PREFS };
  }
  return cache;
}

export async function saveNotifPrefs(prefs: NotifPrefs): Promise<void> {
  cache = { ...prefs };
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {}
}

// Maps a notification `type` (as created in lib/createNotification) to its
// category toggle. Unknown types default to enabled.
export function isNotifTypeEnabled(type?: string | null): boolean {
  switch (type) {
    case 'like': return cache.likes;
    case 'comment': return cache.comments;
    case 'follow': return cache.follows;
    case 'message': return cache.messages;
    default: return true;
  }
}
