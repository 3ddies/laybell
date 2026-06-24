import AsyncStorage from '@react-native-async-storage/async-storage';

// Local, per-user listen history — the data source for the offline "safety net"
// prefetch (lib/offlinePrefetch.ts). The app records streams server-side only to
// CREDIT creators (record_stream); there is no per-user "songs I play most" table,
// and building one server-side would be a privacy + schema cost. So we keep a small
// on-device tally instead: it's exactly what the offline prefetch needs (it runs on
// this device), it works with no network, and it never leaves the phone.
//
// Recorded from the MAIN player only (AudioContext.play) — deliberate plays. The
// ambient feed-song player (PostMusicContext) is intentionally NOT counted, so
// scrolling the feed doesn't pollute "most listened".

export type ListenEntry = {
  id: string;
  uri: string;
  title: string;
  artist: string;
  cover: string | null;
  downloadable: boolean;   // last-known creator opt-out state (re-verified at prefetch)
  count: number;           // number of deliberate plays (proxy for "most listened")
  lastAt: number;          // last played (ms) — recency for "recently listened"
};

export type ListenTrack = { id: string; uri: string; title?: string; artist?: string; cover?: string | null };

const MAX_HISTORY = 120;          // bound the stored map; prune keeps top-by-count ∪ recent
const PERSIST_DEBOUNCE_MS = 1500;

function keyFor(uid: string) { return `listen_history_v1_${uid}`; }

// Per-user in-memory cache so reads/writes don't hit AsyncStorage on every play.
let loadedUid: string | null = null;
let loadPromise: Promise<void> | null = null;
let map = new Map<string, ListenEntry>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

// Memoized per-uid load: concurrent callers (rapid plays) await the SAME promise, so
// the map is only built once and a later play can't write into a half-loaded map.
function load(uid: string): Promise<void> {
  if (loadedUid === uid && loadPromise) return loadPromise;
  loadedUid = uid;
  map = new Map();
  loadPromise = (async () => {
    let next = new Map<string, ListenEntry>();
    try {
      const raw = await AsyncStorage.getItem(keyFor(uid));
      if (raw) for (const e of JSON.parse(raw) as ListenEntry[]) if (e?.id) next.set(e.id, e);
    } catch { next = new Map(); }
    if (loadedUid === uid) map = next;   // ignore if an account switch raced in
  })();
  return loadPromise;
}

function schedulePersist(uid: string) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const snapshot = JSON.stringify(Array.from(map.values()));
    AsyncStorage.setItem(keyFor(uid), snapshot).catch(() => {});
  }, PERSIST_DEBOUNCE_MS);
}

// Keep the map bounded without losing either signal: retain the union of the
// most-played and the most-recent halves, drop the rest.
function pruneIfNeeded() {
  if (map.size <= MAX_HISTORY) return;
  const all = Array.from(map.values());
  const half = Math.floor(MAX_HISTORY / 2);
  const topByCount = [...all].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt).slice(0, half);
  const recent = [...all].sort((a, b) => b.lastAt - a.lastAt).slice(0, half);
  const keep = new Set<string>([...topByCount, ...recent].map((e) => e.id));
  for (const id of Array.from(map.keys())) if (!keep.has(id)) map.delete(id);
}

// Record one deliberate play. Increments the count, refreshes recency + metadata.
export async function recordListen(uid: string, track: ListenTrack, downloadable: boolean): Promise<void> {
  if (!uid || !track?.id || !track?.uri) return;
  await load(uid);
  const now = Date.now();
  const prev = map.get(track.id);
  map.set(track.id, {
    id: track.id,
    uri: track.uri,
    title: track.title ?? prev?.title ?? '',
    artist: track.artist ?? prev?.artist ?? '',
    cover: track.cover ?? prev?.cover ?? null,
    downloadable,
    count: (prev?.count ?? 0) + 1,
    lastAt: now,
  });
  pruneIfNeeded();
  schedulePersist(uid);
}

// The set of tracks the offline prefetch should keep available: the user's top-N
// most-played plus their N most-recent, deduped. Recent come first (the headline
// outage case is "finish the songs I was just playing"), then the rest of the top.
export async function getPrefetchCandidates(uid: string, topN: number, recentN: number): Promise<ListenEntry[]> {
  await load(uid);
  const all = Array.from(map.values());
  if (!all.length) return [];
  const recent = [...all].sort((a, b) => b.lastAt - a.lastAt).slice(0, recentN);
  const top = [...all].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt).slice(0, topN);
  const out: ListenEntry[] = [];
  const seen = new Set<string>();
  for (const e of [...recent, ...top]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

// Sign-out / account-switch cleanup. Clears the in-memory cache so the next user
// can't read the previous user's history.
export async function clearListenHistory(uid: string): Promise<void> {
  if (loadedUid === uid) { map = new Map(); loadedUid = null; loadPromise = null; }
  try { await AsyncStorage.removeItem(keyFor(uid)); } catch {}
}
