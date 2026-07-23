import { useCallback, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { subscribePagerSwiping, getPagerSwiping } from '../contexts/PagerContext';
import { feedPool } from './feedVideoPool';

// ── Per-card feed video playback store ───────────────────────────────────────
// Which feed video is visible / warm / allowed to play, OUTSIDE React state.
//
// Why: these values change constantly during scroll (viewability crossings,
// the fast-scroll gate engaging at finger-down, tab-swipe start/end). As
// HomeScreen state they were deps of renderPost, so EVERY flip gave FlatList a
// new renderItem identity and re-ran every mounted cell (~10-15) — a JS
// reconciliation burst landing exactly at touch-down and at each viewability
// crossing. That was the "slow/medium scroll is choppy, finger registration
// feels weird" symptom (fast flings keep the gate latched, so they were fine).
//
// Here each CARD subscribes to just its own derived booleans via
// useSyncExternalStore: a gate flip re-renders only the 1-2 affected video
// cards; renderPost keeps a stable identity across all scroll-state changes.
// Publishers (index.tsx) keep their exact semantics: eager 40% activation,
// warm neighbors, deferred snapshots during fast scroll, impressions untouched.

let visibleVideoId: string | null = null;
let warmKey = '';                       // joined key — cheap no-op check (mirrors the old setWarmKey string semantics)
let warmSet: ReadonlySet<string> = new Set();
let focused = true;
let swiping = getPagerSwiping();
// App backgrounded (iOS "exit"): feed videos MUST stop — nothing but the main
// music player (react-native-track-player) is allowed to keep sound going in the
// background. `focused` is the FEED-TAB focus and stays true when the whole app
// backgrounds, so without this an autoplaying (or self-healing) video would keep
// running — and playing audio — behind the home screen. Tracks 'background'
// specifically (not the transient 'inactive' of a notification pull / app
// switcher, matching PostMusicContext's ambient-stop rule) so a quick peek
// doesn't stutter playback; on return, canPlay flips back and the centered video
// resumes via FeedVideo's play effect.
let appActive = AppState.currentState !== 'background';
// canPlay gates whether the CENTERED video may play. It intentionally does NOT
// include a fast-scroll flag: the centered video keeps playing right through
// scrolls and flings (Instagram-style continuity) — it only pauses when the feed
// is blurred (!focused), a horizontal tab-swipe is carrying the feed off-screen
// (swiping), or the whole app is backgrounded (!appActive). WHICH video is
// centered is decided in index.tsx (geometry).
let canPlay = true;                     // focused && !swiping && appActive

const subs = new Map<string, Set<() => void>>();
function notify(ids: Iterable<string | null>) {
  for (const id of ids) {
    if (!id) continue;
    const s = subs.get(id);
    if (s) for (const cb of s) cb();
  }
}

export function setVisibleVideoId(next: string | null) {
  if (next === visibleVideoId) return;
  const prev = visibleVideoId;
  visibleVideoId = next;
  // The WATCHED video's pool player must never be stolen by a neighbor's
  // acquisition (naive LRU stealing froze every playing video once feed
  // video density rose).
  feedPool.setProtected(next);
  notify([prev, next]);
}
// The currently-active (centered) video id. index.tsx's geometry resolver reads
// this to implement sticky continuity: when the focus line is momentarily over a
// non-video, it keeps THIS video playing as long as it's still on screen.
export function getVisibleVideoId(): string | null { return visibleVideoId; }

export function setWarmVideoIds(ids: string[]) {
  const key = ids.join('|');
  if (key === warmKey) return;
  const next = new Set(ids);
  // Notify only the symmetric difference — cards whose warm membership changed.
  const changed: string[] = [];
  for (const id of next) if (!warmSet.has(id)) changed.push(id);
  for (const id of warmSet) if (!next.has(id)) changed.push(id);
  warmKey = key;
  warmSet = next;
  notify(changed);
}

function recompute() {
  const next = focused && !swiping && appActive;
  if (next === canPlay) return;
  canPlay = next;
  // shouldPlay only differs for the visible card — the 1-card gate flip.
  notify([visibleVideoId]);
}

const focusSubs = new Set<() => void>();
export function setFeedFocused(on: boolean) {
  if (focused !== on) {
    focused = on;
    for (const cb of focusSubs) cb();
    // Blurred (reels modal / pushed screen): after the FeedVideo components
    // have detached + released (their focus effects run this same tick),
    // dispose the idle players' loaded items — the ONLY safe moment for the
    // disposal stall is when no feed video is on screen.
    if (!on) setTimeout(() => { if (!focused) feedPool.unloadIdle(); }, 400);
  }
  recompute();
}
// FeedVideo subscribes so feed players fully DETACH + UNLOAD while the feed is
// covered (reels modal, pushed screens): paused-but-loaded players kept
// buffering under the modal, starving the reels player's bandwidth.
export function useFeedFocused(): boolean {
  return useSyncExternalStore(
    (cb) => { focusSubs.add(cb); return () => { focusSubs.delete(cb); }; },
    () => focused,
  );
}

// App foreground/background → gate playback (no background sound but the main
// music player) and let FeedVideo force a clean repaint on return. Module-level
// subscription (mirrors the pager store below): the app-state change re-renders
// only the 1-2 mounted video cards, and canPlay recompute pauses/resumes the
// centered one with no HomeScreen churn.
const appSubs = new Set<() => void>();
AppState.addEventListener('change', (s) => {
  const next = s !== 'background';
  if (next === appActive) return;
  appActive = next;
  for (const cb of appSubs) cb();
  recompute();
});
export function useFeedAppActive(): boolean {
  return useSyncExternalStore(
    (cb) => { appSubs.add(cb); return () => { appSubs.delete(cb); }; },
    () => appActive,
  );
}
// Retained for its call sites (index.tsx's scroll gate + resetFeedVideo) but now
// a PLAYBACK no-op: a fast fling no longer pauses the centered video. index.tsx
// still uses its own fastScrollRef to DEFER switching which video is centered
// during a fling (keeping source-swaps off fast-motion frames) — that path just
// no longer force-pauses what's already playing.
export function setFeedFastScrolling(_on: boolean) { /* no-op for playback */ }
// Module-lifetime subscription, mirroring PagerContext's own store pattern —
// tab-swipe start/end now flips playback for ONLY the visible card instead of
// re-rendering the whole feed list at both edges of every pager gesture.
subscribePagerSwiping(() => { swiping = getPagerSwiping(); recompute(); });

// HomeScreen unmount (account switch remounts the tree): start from a clean
// slate exactly like the old fresh useState — without this, a remounted feed
// could briefly autoplay a stale visibleVideoId card before the first
// viewability event lands.
export function resetFeedVideo() {
  setVisibleVideoId(null);
  setWarmVideoIds([]);
  setFeedFastScrolling(false);
}

// isVisibleVideo → the centered card OR a near-viewport neighbor: mounts the
// player (so it pre-loads before the user arrives).
// shouldPlayVideo → mounted AND centered AND settled/focused: actually plays.
export function useCardPlayback(id: string): { isVisibleVideo: boolean; shouldPlayVideo: boolean } {
  const subscribe = useCallback((cb: () => void) => {
    let s = subs.get(id);
    if (!s) { s = new Set(); subs.set(id, s); }
    s.add(cb);
    return () => {
      const set = subs.get(id);
      if (set) { set.delete(cb); if (!set.size) subs.delete(id); }
    };
  }, [id]);
  // Snapshots are primitives, so even a notified card bails unless ITS
  // booleans actually changed.
  const isVisibleVideo = useSyncExternalStore(subscribe, () => visibleVideoId === id || warmSet.has(id));
  const shouldPlayVideo = useSyncExternalStore(subscribe, () => canPlay && visibleVideoId === id);
  return { isVisibleVideo, shouldPlayVideo };
}
