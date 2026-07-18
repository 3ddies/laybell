import { createContext, useContext, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { NativeModules } from 'react-native';
import { buildMediaInfo, buildSplashMediaInfo, TV_SPLASH_MS, type CastItem } from '../lib/cast';
import { useMediaSuspend } from './MediaSuspendContext';
import type { SharePayload } from './ShareContext';

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
// The JS is ALWAYS bundled — what matters is whether the NATIVE module is linked
// in THIS binary. On a dev client built before the Cast rebuild, the JS loads but
// `NativeModules.RNGCCastContext` is undefined; the library's hooks then call
// `Native.getCastState()` and throw "cannot read getCastState of null". Probe the
// exact native module the library reads (`const { RNGCCastContext } = NativeModules`)
// so the real provider only mounts when the native side actually exists.
export const castNativeAvailable = !!RNGC && !!NativeModules.RNGCCastContext;

export type CastValue = {
  /** The native Cast SDK is linked in this binary (else everything is inert). */
  supported: boolean;
  /** A Cast device is discoverable (or connected) — controls whether we show UI. */
  available: boolean;
  /** A Cast session is live — the phone is now a remote. */
  connected: boolean;
  /** A session is being established (device picked, handshake running) — the
      connect wizard shows its "connecting" excitement screen off this. */
  connecting: boolean;
  /** Friendly name of the connected device, when known. */
  deviceName: string | null;
  /** What's currently loaded on the TV. */
  current: CastItem | null;
  isPlaying: boolean;
  /** Receiver playback state: 'idle' | 'loading' | 'buffering' | 'playing' | 'paused'. */
  playerState: string;
  /** The receiver failed to play the current item (idle + error) — offer a retry. */
  mediaError: boolean;
  /** The current item played to the end with nothing left in the queue — the
      UI offers "Play again" (seeks/plays on an ended item revive it instead of
      silently failing on idle media). */
  ended: boolean;
  /** The next queued item, for "Up next" affordances. */
  nextItem: CastItem | null;
  positionSec: number;
  durationSec: number;
  /** Throw an item to the TV (optionally with a queue for next/prev + autoplay-next). */
  cast: (item: CastItem, queue?: CastItem[]) => void;
  play: () => void;
  pause: () => void;
  seekTo: (sec: number) => void;
  /** Jump ±N seconds from wherever playback is (the remote's ±10s buttons). */
  skip: (deltaSec: number) => void;
  next: () => void;
  prev: () => void;
  hasNext: boolean;
  hasPrev: boolean;
  /** Reload the current item on the TV (after a receiver-side media error). */
  retry: () => void;
  /** Open the Cast SDK's full-screen remote (expanded controls). */
  showRemote: () => void;
  /**
   * The in-app full-screen remote (components/TVRemote, hosted by CastBar).
   * Owned here so casting a video can auto-expand it: every EXPLICIT cast()
   * opens it; queue auto-advance does not (re-popping it after the user
   * collapsed it mid-binge would be hostile).
   */
  remoteOpen: boolean;
  openRemote: () => void;
  closeRemote: () => void;
  /**
   * Comments for the video on the TV. Hosted by CastBar as an inOverlay
   * CommentsSheet (plain view, NOT a Modal) stacked above the remote — a real
   * Modal can neither present from the overlay window (deadlock) nor from the
   * main window over the native-modal /tv route (never appears). Snapshotted at
   * open so an autoplay-advance mid-read doesn't swap the thread.
   */
  commentsFor: { postId: string; ownerId: string | null } | null;
  openComments: () => void;
  closeComments: () => void;
  /**
   * Share sheet for the on-TV post — hosted by CastBar with the same inOverlay
   * pattern as the comments. Owned here so that, like the comments, an open
   * share sheet holds queue auto-advance: the finished video loops until the
   * sheet closes (see the autoplay-next effect).
   */
  shareFor: SharePayload | null;
  openShare: (payload: SharePayload) => void;
  closeShare: () => void;
  /** Disconnect from the TV (ends the session). */
  disconnect: () => void;
  /** Open the device picker (used by a manual "cast" affordance). */
  showPicker: () => void;
  /**
   * Kick off device discovery. Android discovers automatically; on iOS our
   * app.json sets `iosDisableDiscoveryAutostart` (so launch never triggers the
   * local-network prompt), which means a Cast surface must start discovery
   * itself when it appears — otherwise no device is ever found and every Cast
   * affordance stays hidden. The TV connect wizard calls this on open.
   */
  startDiscovery: () => void;
};

const INERT: CastValue = {
  supported: false, available: false, connected: false, connecting: false, deviceName: null,
  current: null, isPlaying: false, playerState: 'idle', mediaError: false,
  ended: false, nextItem: null,
  positionSec: 0, durationSec: 0,
  cast: () => {}, play: () => {}, pause: () => {}, seekTo: () => {}, skip: () => {},
  next: () => {}, prev: () => {}, hasNext: false, hasPrev: false,
  retry: () => {}, showRemote: () => {},
  remoteOpen: false, openRemote: () => {}, closeRemote: () => {},
  commentsFor: null, openComments: () => {}, closeComments: () => {},
  shareFor: null, openShare: () => {}, closeShare: () => {},
  disconnect: () => {}, showPicker: () => {}, startDiscovery: () => {},
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
  // 0.5s ticks — at the default 1s the scrubber visibly stutters between jumps.
  const streamPosition: number | null = RNGC.useStreamPosition?.(0.5) ?? null;
  const device: any = RNGC.useCastDevice?.() ?? null;

  const connected = castState === 'connected';
  const available = castState !== 'noDevicesAvailable';

  // While a Cast session is live (or coming up) the phone is a remote, not a
  // second screen — globally suspend background media so a cast video (and its
  // attached song) stops looping with audio on the phone behind the TV
  // controller. AppVideo / FeedVideo / ReelVideo and the ambient post player all
  // honor this; the main music player (the user's deliberate track) is left
  // alone. Covering `connecting` too keeps the phone quiet continuously from the
  // moment a device is picked — no gap between connecting and connected — and
  // ref-counting composes with other suspenders, releasing only when the session
  // fully ends.
  const { suspend, resume } = useMediaSuspend();
  const castingActive = castState === 'connected' || castState === 'connecting';
  useEffect(() => {
    if (!castingActive) return;
    suspend();
    return () => resume();
  }, [castingActive, suspend, resume]);

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
  // Full-screen in-app remote visibility — see the CastValue doc for the rules.
  const [remoteOpen, setRemoteOpen] = useState(false);
  // Comments for the on-TV video (see the CastValue doc). While set, the remote
  // hides; closing restores it.
  const [commentsFor, setCommentsFor] = useState<{ postId: string; ownerId: string | null } | null>(null);
  // Share sheet for the on-TV post (see the CastValue doc) — held here so an
  // open sheet holds queue auto-advance exactly like the comments do.
  const [shareFor, setShareFor] = useState<SharePayload | null>(null);
  // Mirrors for the autoplay-next effect: while the viewer is in the comments
  // or the share sheet, a finished video LOOPS instead of advancing.
  const holdAdvanceRef = useRef(false);
  holdAdvanceRef.current = !!commentsFor || !!shareFor;
  // Last position the receiver actually reported — the revive path (seek on an
  // ended/idle item) anchors relative skips here, since an idle receiver
  // reports no position at all.
  const lastPosRef = useRef(0);
  if (streamPosition != null) lastPosRef.current = streamPosition;

  // Pending splash→video handoff (see loadIndex's splash param). Also read by
  // the autoplay/error/ended plumbing: while it's set, the TV is showing the
  // Laybell card, and receiver states from the CARD must not be mistaken for
  // states of the real item.
  const transitionRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True once THIS session has loaded any real media — the branded-idle effect
  // below must never clobber a load that happened in the same commit (state
  // `current` lags loadIndex by a render).
  const hasLoadedRef = useRef(false);

  const loadIndex = useCallback((i: number, startSec = 0, splash = false) => {
    const item = queueRef.current[i];
    if (!item || !client) return;
    indexRef.current = i;
    advancedRef.current = false;
    hasLoadedRef.current = true;
    setCurrent(item);
    // A new load supersedes any in-flight splash handoff.
    if (transitionRef.current) { clearTimeout(transitionRef.current); transitionRef.current = null; }
    const loadReal = () => {
      try {
        // An explicit startTime pins VOD to a real position (0 = the actual
        // beginning — without it the receiver picks its own join point a few
        // seconds in). Lives omit it so the receiver joins at the live edge.
        client.loadMedia({
          mediaInfo: buildMediaInfo(item),
          autoplay: true,
          ...(item.isLive ? {} : { startTime: Math.max(0, startSec) }),
        });
      } catch { /* client torn down mid-call */ }
    };
    if (!splash) { loadReal(); return; }
    // Moving between posts: flash the Laybell card on the TV for a beat, then
    // load the item. TV-only by design — the phone remote shows the incoming
    // item (loading state) for the whole handoff.
    try {
      client.loadMedia({ mediaInfo: buildSplashMediaInfo(), autoplay: true });
      transitionRef.current = setTimeout(() => { transitionRef.current = null; loadReal(); }, TV_SPLASH_MS);
    } catch { loadReal(); }
  }, [client]);

  const cast = useCallback((item: CastItem, queue?: CastItem[]) => {
    const q = queue && queue.length ? queue : [item];
    const idx = Math.max(0, q.findIndex((x) => x.id === item.id));
    queueRef.current = q;
    indexRef.current = idx;
    if (client) {
      loadIndex(idx);
      // Choosing a video while connected expands straight into the remote.
      setRemoteOpen(true);
    } else {
      // No media client yet — stash the pick; the client-ready effect below
      // loads it as soon as the client exists.
      pendingRef.current = item;
      // Only summon the device picker when there is genuinely NO session. The
      // 3-dot path fires cast() the instant `connected` flips true — before the
      // media client is wired up this render — and popping the picker again
      // there is the spurious second iOS dialog. Worse, that dialog jostles the
      // session state, which momentarily lifts the media-suspend and lets the
      // phone reel's audio resume behind the TV. When already connected, just
      // wait for the client (no dialog); the tab path already behaves this way.
      if (!connected) { try { GCast?.showCastDialog?.(); } catch {} }
    }
  }, [client, loadIndex, connected]);

  // When a client appears and something was queued pre-connection, load it —
  // and expand the remote, so "connect → your video is playing, here are the
  // controls" is one continuous motion.
  useEffect(() => {
    if (client && pendingRef.current) {
      const item = pendingRef.current;
      pendingRef.current = null;
      const idx = Math.max(0, queueRef.current.findIndex((x) => x.id === item!.id));
      loadIndex(idx);
      setRemoteOpen(true);
    }
  }, [client, loadIndex]);

  // Branded idle: a session with a client but nothing to play shows the Laybell
  // card instead of the receiver's stock "ready to cast" screen — and fetching
  // the card NOW warms the receiver's HTTP cache, so the between-video splash
  // appears instantly later instead of grey while the PNG downloads. Declared
  // AFTER the pending-item effect on purpose: effects run in order, so by the
  // time this one fires, a pending video has already loaded and hasLoadedRef
  // (set synchronously in loadIndex) keeps the card from clobbering it.
  useEffect(() => {
    if (!client || current || pendingRef.current || hasLoadedRef.current) return;
    try { client.loadMedia({ mediaInfo: buildSplashMediaInfo(), autoplay: true }); } catch {}
  }, [client, current]);

  // Session ended (disconnected): clear what we thought was playing.
  useEffect(() => {
    if (!connected) {
      setCurrent(null); queueRef.current = []; indexRef.current = 0; pendingRef.current = null;
      if (transitionRef.current) { clearTimeout(transitionRef.current); transitionRef.current = null; }
      hasLoadedRef.current = false;
      setRemoteOpen(false);
      setCommentsFor(null);
      setShareFor(null);
    }
  }, [connected]);

  // Autoplay-next: when the receiver goes idle because the clip FINISHED, roll
  // to the next queued item (YouTube-style). Other idle reasons (user stop,
  // interrupted) do nothing.
  //
  // EXCEPT while the phone's comments or share sheet is open: the viewer is
  // mid-read/mid-send, so the finished video LOOPS on the TV instead of
  // advancing out from under them. Each replay re-checks — the playthrough
  // that's running when they close the sheet completes its full loop, then
  // the queue advances as normal.
  useEffect(() => {
    const st = mediaStatus?.playerState;
    const reason = mediaStatus?.idleReason;
    // Statuses reported while the Laybell splash card is up belong to the
    // CARD, not the item — acting on them would double-advance the queue.
    if (transitionRef.current) return;
    if (st === 'idle' && reason === 'finished' && !advancedRef.current) {
      advancedRef.current = true;
      // Loop replays stay seamless (no splash) — the card marks a POST CHANGE.
      if (holdAdvanceRef.current) { loadIndex(indexRef.current); return; }
      const nextI = indexRef.current + 1;
      if (nextI < queueRef.current.length) loadIndex(nextI, 0, true);
    }
  }, [mediaStatus, loadIndex]);

  // Seeks and play on IDLE media silently fail (the receiver has unloaded it) —
  // exactly what happens when someone rewinds a video in its final seconds and
  // it finishes before the seek lands. Detect idle and RELOAD the item at the
  // requested position instead, so the controls always do something.
  const idleNow = useCallback(
    () => (mediaStatus?.playerState ?? 'idle') === 'idle',
    [mediaStatus],
  );

  const play = useCallback(() => {
    if (idleNow()) { loadIndex(indexRef.current); return; } // ended → play = replay
    try { client?.play(); } catch {}
  }, [client, idleNow, loadIndex]);
  const pause = useCallback(() => { try { client?.pause(); } catch {} }, [client]);
  const retry = useCallback(() => { loadIndex(indexRef.current); }, [loadIndex]);
  const showRemote = useCallback(() => { try { GCast?.showExpandedControls?.(); } catch {} }, []);
  const seekTo = useCallback((sec: number) => {
    if (idleNow()) { loadIndex(indexRef.current, sec); return; } // revive at the target
    try { client?.seek({ position: Math.max(0, sec) }); } catch {}
  }, [client, idleNow, loadIndex]);
  // Relative seek — the receiver clamps to [0, duration], and keeping it
  // relative avoids racing the stream-position ticks.
  const skip = useCallback((deltaSec: number) => {
    if (idleNow()) { loadIndex(indexRef.current, lastPosRef.current + deltaSec); return; }
    try { client?.seek({ position: deltaSec, relative: true }); } catch {}
  }, [client, idleNow, loadIndex]);
  // Manual queue moves get the branded splash too — same post-change moment.
  const next = useCallback(() => { if (indexRef.current + 1 < queueRef.current.length) loadIndex(indexRef.current + 1, 0, true); }, [loadIndex]);
  const prev = useCallback(() => { if (indexRef.current - 1 >= 0) loadIndex(indexRef.current - 1, 0, true); }, [loadIndex]);
  const disconnect = useCallback(() => {
    try { GCast?.getSessionManager?.()?.endCurrentSession?.(true); } catch {}
  }, []);
  const showPicker = useCallback(() => { try { GCast?.showCastDialog?.(); } catch {} }, []);
  // Stable identities for the overlay chrome. The context value is rebuilt on
  // every 0.5s position tick, so anything memoized against these (the comments
  // sheet, most importantly) must not see a new function each tick.
  const currentRef = useRef<CastItem | null>(null);
  currentRef.current = current;
  const openRemote = useCallback(() => setRemoteOpen(true), []);
  const closeRemote = useCallback(() => setRemoteOpen(false), []);
  const openComments = useCallback(() => {
    const c = currentRef.current;
    if (!c) return;
    setCommentsFor({ postId: c.id, ownerId: c.authorId ?? null });
  }, []);
  const closeComments = useCallback(() => setCommentsFor(null), []);
  const openShare = useCallback((payload: SharePayload) => setShareFor(payload), []);
  const closeShare = useCallback(() => setShareFor(null), []);
  const startDiscovery = useCallback(() => {
    // No-op on Android (discovery is automatic); on iOS this is what makes
    // devices appear given discovery autostart is disabled at launch.
    try { GCast?.getDiscoveryManager?.()?.startDiscovery?.(); } catch {}
  }, []);

  const playerState: string = mediaStatus?.playerState ?? 'idle';
  const value: CastValue = {
    supported: true,
    available,
    connected,
    connecting: castState === 'connecting',
    deviceName: device?.friendlyName ?? null,
    current,
    isPlaying: playerState === 'playing',
    playerState,
    // idle+error with something loaded = the receiver rejected the stream (bad
    // manifest, unsupported segments, network) — CastBar shows a retry state.
    // Splash handoff pending → any idle state belongs to the Laybell card
    // (e.g. the image failing to fetch), not the item: stay calm, the timer
    // loads the real thing momentarily.
    mediaError: !!current && !transitionRef.current && playerState === 'idle' && mediaStatus?.idleReason === 'error',
    // Finished with nothing queued after it (with a next item, autoplay-next
    // rolls on before anyone sees this) — the UI flips play into replay.
    ended: !!current && !transitionRef.current && playerState === 'idle' && mediaStatus?.idleReason === 'finished',
    nextItem: queueRef.current[indexRef.current + 1] ?? null,
    positionSec: streamPosition ?? 0,
    durationSec: mediaStatus?.mediaInfo?.streamDuration ?? 0,
    cast, play, pause, seekTo, skip, next, prev,
    hasNext: indexRef.current + 1 < queueRef.current.length,
    hasPrev: indexRef.current > 0,
    retry, showRemote,
    remoteOpen,
    openRemote,
    closeRemote,
    commentsFor,
    // The sheet stacks ABOVE the remote in the same overlay window, so the
    // remote just stays put underneath — closing reveals it exactly as left.
    openComments,
    closeComments,
    shareFor, openShare, closeShare,
    disconnect, showPicker, startDiscovery,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// The choice is fixed for the app's lifetime (a module-load constant), so the
// two providers never swap at runtime — React's hook rules stay satisfied.
export const CastProvider = castNativeAvailable ? RealCastProvider : NoopCastProvider;
