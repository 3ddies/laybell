// ── Auto-DJ store (Listen Mode) ──────────────────────────────────────────────
// A module singleton that owns the (lazily-created) native DjEngine + the
// AutoDjController, plus a tiny React-subscribable state. Lives outside React so
// Auto-DJ keeps playing while screens mount/unmount; the Listen-mode screen drives
// it. See docs/AUTO_DJ_SPEC.md. The engine is native (react-native-audio-api), so
// it is require()'d lazily — importing this module is always safe.
import { useSyncExternalStore } from 'react';
import { AutoDjController, type AutoDjTrack } from './AutoDjController';
import type { DjEngine } from './DjEngine';

export type { AutoDjTrack } from './AutoDjController';

type State = { active: boolean; mixing: boolean; paused: boolean; track: AutoDjTrack | null; index: number };
let state: State = { active: false, mixing: false, paused: false, track: null, index: 0 };
const subs = new Set<() => void>();
const emit = () => { for (const cb of subs) cb(); };
const set = (p: Partial<State>) => { state = { ...state, ...p }; emit(); };

let engine: DjEngine | null = null;
let controller: AutoDjController | null = null;
let queue: AutoDjTrack[] = [];
let onHandBack: ((remaining: AutoDjTrack[]) => void) | null = null;
// "An ad is due AND there's eligible inventory" — owned by AudioContext (it has the ad clock +
// inventory probe), consulted by the controller to hold an opportunistic transition so the break
// lands on a clean boundary. Kept at module scope so it survives the controller being torn down and
// rebuilt between Listen-Mode sessions; re-applied in ensure().
let adGate: (() => boolean) | null = null;

const log = (...a: unknown[]) => { if (__DEV__) console.log('[auto-dj]', ...a); };

function ensure(): AutoDjController | null {
  if (controller) return controller;
  try {
    // Lazy — the native engine isn't in a build that predates it; a static import
    // would crash app startup (see app/dj.tsx).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./DjEngine') as typeof import('./DjEngine');
    engine = new mod.DjEngine();
    controller = new AutoDjController(engine);
    controller.setListener({
      onTrack: (track, index) => set({ track, index }),
      onMixing: (mixing) => set({ mixing }),
    });
    controller.setAdGate(adGate); // re-apply across teardown/rebuild
    return controller;
  } catch (e) {
    log('ensure() FAILED to construct the native engine', e);
    engine = null;
    controller = null;
    return null;
  }
}

/** Start Auto-DJ on `tracks`. `pauseMusic` quiets the normal player (keep its session —
 *  never stop()); `handBack` is called with the remaining tracks if Auto-DJ is turned off,
 *  so the normal player can resume. Returns false if the native engine isn't available. */
export async function startAutoDj(
  tracks: AutoDjTrack[],
  index: number,
  opts: { pauseMusic?: () => void; handBack?: (remaining: AutoDjTrack[]) => void } = {},
): Promise<boolean> {
  log('startAutoDj()', { tracks: tracks.length, index });
  const c = ensure();
  if (!c || !engine) { log('engine unavailable — ensure() returned null (native module missing?)'); return false; }
  try {
    log('init…');
    await engine.init();                    // resume the context + claim the session BEFORE playback
    queue = tracks;
    onHandBack = opts.handBack ?? null;
    try { opts.pauseMusic?.(); } catch {}
    await c.start(tracks, index, 0);
    set({ active: true, paused: false });
    return true;
  } catch (e) {
    // Anything failed (decode, session) → tear down so the caller falls back to the normal
    // player; Listen Mode must always start a song.
    if (__DEV__) console.log('[auto-dj] start failed → falling back to the normal player', e);
    try { c.stop(); } catch {}
    try { void engine?.dispose(); } catch {}
    engine = null;
    controller = null;
    set({ active: false, mixing: false, track: null });
    return false;
  }
}

/** Stop Auto-DJ and tear the engine down (releases the audio session). When `handBack` is
 *  true, the remaining tracks are passed to the hand-back callback so the normal player
 *  can pick up where it left off. */
export function stopAutoDj(handBack = false): void {
  const idx = controller?.currentIndex ?? 0;
  controller?.stop();
  void engine?.dispose();
  engine = null;
  controller = null;
  set({ active: false, mixing: false, paused: false, track: null });
  if (handBack && onHandBack && queue.length) onHandBack(queue.slice(idx));
  onHandBack = null;
  queue = [];
}

// The lock-screen next button fires through BOTH remote-command centers at once (track-player's and
// the audio-api engine's — see contexts/AudioContext), so one press can call this twice. Debounce to
// a single skip. (pause/resume/seek are idempotent, so only skip needs it.)
let lastSkipAt = 0;
export function skipAutoDj(): void {
  const now = Date.now();
  if (now - lastSkipAt < 350) return; // dedupe the one-press double-fire; still allows brisk manual skipping
  lastSkipAt = now;
  void controller?.skipNext();
}
export function pauseAutoDj(): void { controller?.pause(); set({ paused: true }); }
export function resumeAutoDj(): void { controller?.resume(); set({ paused: false }); }
export function seekAutoDj(ms: number): void { controller?.seek(ms / 1000); }

// Install the "ad due + eligible" gate (see the module note above). Stored so a controller created
// later (or rebuilt for the next session) picks it up in ensure(); forwarded immediately if one
// already exists. AudioContext sets it once at app start and the closure reads stable refs.
export function setAutoDjAdGate(fn: (() => boolean) | null): void { adGate = fn; controller?.setAdGate(fn); }

// Pause/resume the decks for an AD BREAK — distinct from the user pause above: it does NOT set the
// user-facing `paused` state (the ad UI covers the player), it only quiets the engine so the ad has
// the floor, then resumes the live track exactly where the ad interrupted it.
export function pauseAutoDjForAd(): void { controller?.pause(); }
export function resumeAutoDjForAd(): void { controller?.resume(); }
export function autoDjPosition(): { pos: number; dur: number } { return controller?.position() ?? { pos: 0, dur: 0 }; }
export function isAutoDjActive(): boolean { return state.active; }

export function useAutoDj(): State {
  return useSyncExternalStore(
    (cb) => { subs.add(cb); return () => { subs.delete(cb); }; },
    () => state,
  );
}
