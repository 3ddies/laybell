import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudioPlayer } from 'expo-audio';
import type { StudioRadioState } from '../lib/live';
import {
  createRadioPlayer, emptyRadio, radioPositionMs,
  DRIFT_TOLERANCE_MS, RADIO_HEARTBEAT_MS, type RadioTrack,
} from '../lib/studioRadio';

// Keeps one device in step with the room's radio, and — if this device is the
// host's — decides what the room is playing in the first place.
//
// Both sides run the SAME local player. The host is not privileged in playback,
// only in authorship: it is the one that publishes state and the one that
// notices a song has ended and starts the next. Everyone else follows.

type Options = {
  isHost: boolean;
  /** channel.sendRadio — host only. */
  publish?: (state: Omit<StudioRadioState, 'hostAt'>) => void;
  /** channel.requestRadio — asked once on join so a late arrival syncs at once. */
  request?: () => void;
  /** True once the channel is actually up; nothing is sent before that. */
  ready: boolean;
  /**
   * Called the moment a song is loaded to play here. The screens pass the app
   * music player's stop, because the two are separate players and would
   * otherwise both be audible — the studio radio on one, whatever the user was
   * listening to before they walked in on the other.
   */
  onTakeOver?: () => void;
};

export function useStudioRadio({ isHost, publish, request, ready, onTakeOver }: Options) {
  const [state, setState] = useState<StudioRadioState>(emptyRadio);
  const [queue, setQueue] = useState<RadioTrack[]>([]);
  // Local-only. An artist about to record does not want the room's song in
  // their headphones, and muting must not stop it for everybody else.
  const [localMuted, setLocalMuted] = useState(false);

  const playerRef = useRef<AudioPlayer | null>(null);
  const loadedIdRef = useRef<string | null>(null);
  // Receiver clock minus host clock, measured when state arrives. See
  // radioPositionMs — this is the difference between "roughly together" and
  // "a second apart on two phones".
  const skewRef = useRef(0);
  const stateRef = useRef(state); stateRef.current = state;
  const queueRef = useRef(queue); queueRef.current = queue;
  const mutedRef = useRef(localMuted); mutedRef.current = localMuted;

  const destroyPlayer = useCallback(() => {
    const p = playerRef.current;
    playerRef.current = null;
    loadedIdRef.current = null;
    if (p) { try { p.pause(); } catch {} try { p.remove(); } catch {} }
  }, []);

  // ── Receiving ──────────────────────────────────────────────────────────────
  const applyRemote = useCallback((incoming: StudioRadioState) => {
    skewRef.current = Date.now() - incoming.hostAt;
    setState(incoming);
  }, []);

  // ── Publishing (host) ──────────────────────────────────────────────────────
  const pushState = useCallback((next: Omit<StudioRadioState, 'hostAt'>) => {
    setState({ ...next, hostAt: Date.now() });
    skewRef.current = 0;             // the host is its own clock
    publish?.(next);
  }, [publish]);

  const playTrack = useCallback((track: RadioTrack, positionMs = 0) => {
    pushState({ track, startedAt: Date.now(), positionMs, paused: false });
  }, [pushState]);

  const pause = useCallback(() => {
    const s = stateRef.current;
    if (!s.track || s.paused) return;
    pushState({ ...s, positionMs: radioPositionMs(s, skewRef.current), startedAt: Date.now(), paused: true });
  }, [pushState]);

  const resume = useCallback(() => {
    const s = stateRef.current;
    if (!s.track || !s.paused) return;
    pushState({ ...s, startedAt: Date.now(), paused: false });
  }, [pushState]);

  const stop = useCallback(() => {
    setQueue([]);
    pushState({ track: null, startedAt: Date.now(), positionMs: 0, paused: true });
  }, [pushState]);

  // Advance. Used by Skip and by the end of a song — one path, so the queue can
  // never be consumed twice for the same track.
  const advance = useCallback(() => {
    const [next, ...rest] = queueRef.current;
    setQueue(rest);
    if (next) pushState({ track: next, startedAt: Date.now(), positionMs: 0, paused: false });
    else pushState({ track: null, startedAt: Date.now(), positionMs: 0, paused: true });
  }, [pushState]);

  const enqueue = useCallback((track: RadioTrack) => {
    // Nothing on air: go straight on rather than into a queue nobody is draining.
    if (!stateRef.current.track) { playTrack(track); return 'playing' as const; }
    setQueue((q) => (q.some((t) => t.id === track.id) ? q : [...q, track]));
    return 'queued' as const;
  }, [playTrack]);

  const removeQueued = useCallback((id: string) => {
    setQueue((q) => q.filter((t) => t.id !== id));
  }, []);

  // ── Local playback ─────────────────────────────────────────────────────────
  // Load / unload as the track changes.
  useEffect(() => {
    const track = state.track;
    if (!track) { destroyPlayer(); return; }
    if (loadedIdRef.current === track.id) return;

    destroyPlayer();
    try {
      onTakeOver?.();
      const p = createRadioPlayer(track.uri);
      playerRef.current = p;
      loadedIdRef.current = track.id;
      p.volume = mutedRef.current ? 0 : 1;
      const pos = radioPositionMs(state, skewRef.current);
      // Joining mid-song is the normal case, not the exception.
      if (pos > 250) { try { p.seekTo(pos / 1000); } catch {} }
      if (!state.paused) { try { p.play(); } catch {} }
    } catch {
      destroyPlayer();
    }
    // state.paused / position are read once at load on purpose — the effects
    // below own them from then on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.track?.id, destroyPlayer]);

  useEffect(() => () => destroyPlayer(), [destroyPlayer]);

  // Pause / resume, and re-seek on an explicit position change.
  useEffect(() => {
    const p = playerRef.current;
    if (!p || !state.track) return;
    try {
      if (state.paused) { p.pause(); p.seekTo(state.positionMs / 1000); }
      else p.play();
    } catch {}
  }, [state.paused, state.positionMs, state.track]);

  useEffect(() => {
    const p = playerRef.current;
    if (p) { try { p.volume = localMuted ? 0 : 1; } catch {} }
  }, [localMuted]);

  // Drift correction + (host only) end-of-song. One timer for both, because
  // they ask the same question: where is this device versus the room?
  useEffect(() => {
    if (!state.track) return;
    const iv = setInterval(() => {
      const s = stateRef.current;
      if (!s.track) return;
      const want = radioPositionMs(s, skewRef.current);

      if (isHost && !s.paused) {
        // `posts.duration` is not always populated, and a null there would mean
        // a song that plays to the end and then sits there forever with the
        // queue untouched. The loaded player knows the real length — use that
        // when the row does not.
        const known = s.track.durationMs
          ?? ((playerRef.current?.duration ?? 0) * 1000 || null);
        if (known && want >= known - 250) { advance(); return; }
      }

      const p = playerRef.current;
      if (!p || s.paused) return;
      try {
        const have = (p.currentTime ?? 0) * 1000;
        // A player still buffering reports 0 — seeking on that would fight the
        // load and stutter, so only correct once it is actually moving.
        if (have > 250 && Math.abs(have - want) > DRIFT_TOLERANCE_MS) p.seekTo(want / 1000);
      } catch {}
    }, 2000);
    return () => clearInterval(iv);
  }, [state.track, isHost, advance]);

  // Host heartbeat: re-announce so a dropped packet heals itself, and so anyone
  // who arrived between songs is never stuck on a stale card.
  useEffect(() => {
    if (!isHost || !ready) return;
    const iv = setInterval(() => {
      const s = stateRef.current;
      publish?.({ track: s.track, startedAt: s.startedAt, positionMs: s.positionMs, paused: s.paused });
    }, RADIO_HEARTBEAT_MS);
    return () => clearInterval(iv);
  }, [isHost, ready, publish]);

  // Host: answer "what's on?" immediately.
  const answerRequest = useCallback(() => {
    if (!isHost) return;
    const s = stateRef.current;
    publish?.({ track: s.track, startedAt: s.startedAt, positionMs: s.positionMs, paused: s.paused });
  }, [isHost, publish]);

  // Listener/member: ask once the channel is live.
  const askedRef = useRef(false);
  useEffect(() => {
    if (isHost || !ready || askedRef.current) return;
    askedRef.current = true;
    request?.();
  }, [isHost, ready, request]);

  return {
    state, queue, localMuted, setLocalMuted,
    applyRemote, answerRequest,
    playTrack, pause, resume, stop, advance, enqueue, removeQueued,
    positionMs: () => radioPositionMs(stateRef.current, skewRef.current),
  };
}
