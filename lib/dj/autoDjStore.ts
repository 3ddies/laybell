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

export function skipAutoDj(): void { void controller?.skipNext(); }
export function pauseAutoDj(): void { controller?.pause(); set({ paused: true }); }
export function resumeAutoDj(): void { controller?.resume(); set({ paused: false }); }
export function autoDjPosition(): { pos: number; dur: number } { return controller?.position() ?? { pos: 0, dur: 0 }; }
export function isAutoDjActive(): boolean { return state.active; }

export function useAutoDj(): State {
  return useSyncExternalStore(
    (cb) => { subs.add(cb); return () => { subs.delete(cb); }; },
    () => state,
  );
}
