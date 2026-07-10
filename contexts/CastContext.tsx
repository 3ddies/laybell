import { createContext, useContext, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { buildMediaInfo, type CastItem } from '../lib/cast';

// ─── Laybell TV casting (Google Cast / Chromecast) ───────────────────────────
//
// The phone becomes the remote: it "throws" the selected Laybell TV video/live
// to a Cast device and then drives playback (play/pause/seek/next/stop). The
// TV's own remote also controls the receiver, so both control modes work.
//
// GUARDED: react-native-google-cast is a NATIVE module. A dev client built
// before it was linked (i.e. every current install, until the next rebuild)
// must still boot — so the require is wrapped and, when it's absent, the whole
// context degrades to inert no-ops and every Cast affordance renders nothing.
// Nothing here can crash a binary that lacks the Cast SDK.

let RNGC: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  RNGC = require('react-native-google-cast');
} catch {
  /* native Cast module not in this binary yet — stays null, everything no-ops */
}
// The static Cast API (session dialog + session manager) lives on the default
// export in v4; fall back across shapes so a minor version bump can't break it.
const GCast: any = RNGC?.default ?? RNGC?.CastContext ?? RNGC ?? null;
export const castNativeAvailable = !!RNGC && !!(RNGC.useRemoteMediaClient || RNGC.CastButton);

export type CastValue = {
  /** The native Cast SDK is linked in this binary (else everything is inert). */
  supported: boolean;
  /** A Cast device is discoverable (or connected) — controls whether we show UI. */
  available: boolean;
  /** A Cast session is live — the phone is now a remote. */
  connected: boolean;
  /** Friendly name of the connected device, when known. */
  deviceName: string | null;
  /** What's currently loaded on the TV. */
  current: CastItem | null;
  isPlaying: boolean;
  positionSec: number;
  durationSec: number;
  /** Throw an item to the TV (optionally with a queue for next/prev + autoplay-next). */
  cast: (item: CastItem, queue?: CastItem[]) => void;
  play: () => void;
  pause: () => void;
  seekTo: (sec: number) => void;
  next: () => void;
  prev: () => void;
  hasNext: boolean;
  hasPrev: boolean;
  /** Disconnect from the TV (ends the session). */
  disconnect: () => void;
  /** Open the device picker (used by a manual "cast" affordance). */
  showPicker: () => void;
};

const INERT: CastValue = {
  supported: false, available: false, connected: false, deviceName: null,
  current: null, isPlaying: false, positionSec: 0, durationSec: 0,
  cast: () => {}, play: () => {}, pause: () => {}, seekTo: () => {},
  next: () => {}, prev: () => {}, hasNext: false, hasPrev: false,
  disconnect: () => {}, showPicker: () => {},
};

const Ctx = createContext<CastValue>(INERT);
export const useCast = () => useContext(Ctx);

// ── No-op provider (native module absent) — just serves INERT. ───────────────
function NoopCastProvider({ children }: { children: ReactNode }) {
  return <Ctx.Provider value={INERT}>{children}</Ctx.Provider>;
}

// ── Real provider (native module present) — wires the Cast SDK hooks. ─────────
function RealCastProvider({ children }: { children: ReactNode }) {
  const castState: string = RNGC.useCastState?.() ?? 'noDevicesAvailable';
  const client: any = RNGC.useRemoteMediaClient?.() ?? null;
  const mediaStatus: any = RNGC.useMediaStatus?.() ?? null;
  const streamPosition: number | null = RNGC.useStreamPosition?.() ?? null;
  const device: any = RNGC.useCastDevice?.() ?? null;

  const connected = castState === 'connected';
  const available = castState !== 'noDevicesAvailable';

  // Local queue drives next/prev + autoplay-next, so we don't depend on the
  // receiver's own queue model (which differs across receiver types).
  const queueRef = useRef<CastItem[]>([]);
  const indexRef = useRef(0);
  // An item tapped BEFORE a session exists: stashed, then loaded the moment the
  // remote client comes up (after the user picks a device in the dialog).
  const pendingRef = useRef<CastItem | null>(null);
  // Guards autoplay-next so it fires once per "finished", not on every status tick.
  const advancedRef = useRef(false);

  const [current, setCurrent] = useState<CastItem | null>(null);

  const loadIndex = useCallback((i: number) => {
    const item = queueRef.current[i];
    if (!item || !client) return;
    indexRef.current = i;
    advancedRef.current = false;
    setCurrent(item);
    try {
      client.loadMedia({ mediaInfo: buildMediaInfo(item), autoplay: true });
    } catch { /* client torn down mid-call */ }
  }, [client]);

  const cast = useCallback((item: CastItem, queue?: CastItem[]) => {
    const q = queue && queue.length ? queue : [item];
    const idx = Math.max(0, q.findIndex((x) => x.id === item.id));
    queueRef.current = q;
    indexRef.current = idx;
    if (client) {
      loadIndex(idx);
    } else {
      // Not connected yet — remember the pick and open the device picker; the
      // effect below loads it once a client exists.
      pendingRef.current = item;
      try { GCast?.showCastDialog?.(); } catch {}
    }
  }, [client, loadIndex]);

  // When a client appears and something was queued pre-connection, load it.
  useEffect(() => {
    if (client && pendingRef.current) {
      const item = pendingRef.current;
      pendingRef.current = null;
      const idx = Math.max(0, queueRef.current.findIndex((x) => x.id === item!.id));
      loadIndex(idx);
    }
  }, [client, loadIndex]);

  // Session ended (disconnected): clear what we thought was playing.
  useEffect(() => {
    if (!connected) { setCurrent(null); queueRef.current = []; indexRef.current = 0; pendingRef.current = null; }
  }, [connected]);

  // Autoplay-next: when the receiver goes idle because the clip FINISHED, roll
  // to the next queued item (YouTube-style). Other idle reasons (user stop,
  // interrupted) do nothing.
  useEffect(() => {
    const st = mediaStatus?.playerState;
    const reason = mediaStatus?.idleReason;
    if (st === 'idle' && reason === 'finished' && !advancedRef.current) {
      advancedRef.current = true;
      const nextI = indexRef.current + 1;
      if (nextI < queueRef.current.length) loadIndex(nextI);
    }
  }, [mediaStatus, loadIndex]);

  const play = useCallback(() => { try { client?.play(); } catch {} }, [client]);
  const pause = useCallback(() => { try { client?.pause(); } catch {} }, [client]);
  const seekTo = useCallback((sec: number) => { try { client?.seek({ position: Math.max(0, sec) }); } catch {} }, [client]);
  const next = useCallback(() => { if (indexRef.current + 1 < queueRef.current.length) loadIndex(indexRef.current + 1); }, [loadIndex]);
  const prev = useCallback(() => { if (indexRef.current - 1 >= 0) loadIndex(indexRef.current - 1); }, [loadIndex]);
  const disconnect = useCallback(() => {
    try { GCast?.getSessionManager?.()?.endCurrentSession?.(true); } catch {}
  }, []);
  const showPicker = useCallback(() => { try { GCast?.showCastDialog?.(); } catch {} }, []);

  const value: CastValue = {
    supported: true,
    available,
    connected,
    deviceName: device?.friendlyName ?? null,
    current,
    isPlaying: mediaStatus?.playerState === 'playing',
    positionSec: streamPosition ?? 0,
    durationSec: mediaStatus?.mediaInfo?.streamDuration ?? 0,
    cast, play, pause, seekTo, next, prev,
    hasNext: indexRef.current + 1 < queueRef.current.length,
    hasPrev: indexRef.current > 0,
    disconnect, showPicker,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// The choice is fixed for the app's lifetime (a module-load constant), so the
// two providers never swap at runtime — React's hook rules stay satisfied.
export const CastProvider = castNativeAvailable ? RealCastProvider : NoopCastProvider;
