import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudioPlayer } from 'expo-audio';
import type { StudioRadioState } from '../lib/live';
import { getDeviceId } from '../lib/deviceId';
import { recordStream } from '../lib/streamOutbox';
import {
  createRadioPlayer, emptyRadio, radioPositionMs,
  DRIFT_TOLERANCE_MS, RADIO_HEARTBEAT_MS, type RadioTrack,
} from '../lib/studioRadio';

// Keeps one device in step with the room's radio, and — if this device is the
// host's — decides what the room is playing in the first place.
//
// Both sides run the SAME local player. The host is not privileged in playback,
// only in authorship: it publishes state, it notices a song has ended, and it
// owns the running order. Everyone else follows.

/** Genuine forward playback that earns the artist a stream credit. */
const streamCreditAtMs = (durationMs: number | null) =>
  Math.min(30_000, durationMs ? durationMs * 0.5 : 30_000);

/**
 * Slider position → actual gain.
 *
 * Loudness is heard logarithmically, so a LINEAR gain barely moves the bottom
 * half of the fader: at 0.15 the signal is only about −16 dB and still plainly
 * audible, which is exactly the "I dragged it almost to zero and it is still
 * loud" complaint. Cubing it makes the fader behave like every other volume
 * control — 0.5 lands near a quarter of the power, and the last tenth of travel
 * actually reaches silence.
 */
export const volumeGain = (v: number) => Math.max(0, Math.min(1, v)) ** 3;

/** A tick longer than this is a seek or a track change, not listening. */
const MAX_GENUINE_DELTA_MS = 2600;
const TICK_MS = 2000;
/** Press previous after this much of a song and it restarts instead. */
const RESTART_BEFORE_MS = 3000;

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
   * otherwise both be audible.
   */
  onTakeOver?: () => void;
  /** Signed-in user, for stream credit. Null simply skips crediting. */
  viewerId?: string | null;
};

export function useStudioRadio({ isHost, publish, request, ready, onTakeOver, viewerId }: Options) {
  const [state, setState] = useState<StudioRadioState>(emptyRadio);
  // The RUNNING ORDER, not a consume-once queue. Holding the whole list with a
  // cursor is what makes "previous" possible at all, and it is the only model
  // that matches loading a playlist: skipping back through a queue you have
  // already eaten is not something you can do.
  const [list, setList] = useState<RadioTrack[]>([]);
  const [index, setIndex] = useState(-1);
  // Local-only output level. The room is unaffected — an artist about to record
  // wants the song quiet in their own ears without silencing it for anyone else.
  const [volume, setVolume] = useState(1);
  const [localMuted, setLocalMuted] = useState(false);


  const playerRef = useRef<AudioPlayer | null>(null);
  const loadedIdRef = useRef<string | null>(null);
  const skewRef = useRef(0);
  const stateRef = useRef(state); stateRef.current = state;
  const listRef = useRef(list); listRef.current = list;
  const indexRef = useRef(index); indexRef.current = index;
  const gainRef = useRef(1); gainRef.current = localMuted ? 0 : volumeGain(volume);

  // Stream credit, accumulated the same way the main player does it: genuine
  // forward playback only, then one credit per track. Every device counts its
  // own listen, which is the honest answer for radio — ten people hearing a
  // song is ten listens. The server's per-user/per-device caps dedupe.
  const deviceIdRef = useRef<string | null>(null);
  const heardMsRef = useRef(0);
  const creditedRef = useRef<string | null>(null);
  const lastPosRef = useRef(0);
  useEffect(() => { getDeviceId().then((d) => { deviceIdRef.current = d; }).catch(() => {}); }, []);

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

  const playAt = useCallback((tracks: RadioTrack[], i: number) => {
    const track = tracks[i];
    if (!track) { pushState({ track: null, startedAt: Date.now(), positionMs: 0, paused: true }); setIndex(-1); return; }
    setIndex(i);
    pushState({ track, startedAt: Date.now(), positionMs: 0, paused: false });
  }, [pushState]);

  /** Load a whole list (a playlist, likes, saves) and start at one of them. */
  const playList = useCallback((tracks: RadioTrack[], startIndex = 0) => {
    setList(tracks);
    playAt(tracks, startIndex);
  }, [playAt]);

  const playTrack = useCallback((track: RadioTrack) => {
    setList((l) => {
      const at = l.findIndex((t) => t.id === track.id);
      const nextList = at >= 0 ? l : [...l, track];
      playAt(nextList, at >= 0 ? at : nextList.length - 1);
      return nextList;
    });
  }, [playAt]);

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
    setList([]); setIndex(-1);
    pushState({ track: null, startedAt: Date.now(), positionMs: 0, paused: true });
  }, [pushState]);

  /** Forward. Also what the end of a song calls, so a track can never double-advance. */
  const next = useCallback(() => {
    const l = listRef.current;
    const i = indexRef.current + 1;
    if (i >= l.length) { stop(); return; }
    playAt(l, i);
  }, [playAt, stop]);

  /**
   * Back. Deep into a song this restarts it instead of skipping — the same rule
   * every music player uses, and the one people already expect from the button.
   */
  const previous = useCallback(() => {
    const s = stateRef.current;
    if (!s.track) return;
    const pos = radioPositionMs(s, skewRef.current);
    if (pos > RESTART_BEFORE_MS || indexRef.current <= 0) {
      pushState({ ...s, startedAt: Date.now(), positionMs: 0, paused: false });
      return;
    }
    playAt(listRef.current, indexRef.current - 1);
  }, [playAt, pushState]);

  const enqueue = useCallback((track: RadioTrack) => {
    if (!stateRef.current.track) { playTrack(track); return 'playing' as const; }
    setList((l) => (l.some((t) => t.id === track.id) ? l : [...l, track]));
    return 'queued' as const;
  }, [playTrack]);

  const removeQueued = useCallback((id: string) => {
    setList((l) => {
      const at = l.findIndex((t) => t.id === id);
      if (at < 0 || at === indexRef.current) return l;   // never drop what is playing
      if (at < indexRef.current) setIndex((i) => i - 1);
      return l.filter((t) => t.id !== id);
    });
  }, []);

  // ── Local playback ─────────────────────────────────────────────────────────
  useEffect(() => {
    const track = state.track;
    if (!track) { destroyPlayer(); return; }
    if (loadedIdRef.current === track.id) return;

    destroyPlayer();
    heardMsRef.current = 0;
    lastPosRef.current = 0;
    try {
      onTakeOver?.();
      const p = createRadioPlayer(track.uri);
      playerRef.current = p;
      loadedIdRef.current = track.id;
      p.volume = gainRef.current;
      const pos = radioPositionMs(state, skewRef.current);
      if (pos > 250) { try { p.seekTo(pos / 1000); } catch {} }   // joining mid-song is normal
      if (!state.paused) { try { p.play(); } catch {} }
    } catch {
      destroyPlayer();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.track?.id, destroyPlayer]);

  useEffect(() => () => destroyPlayer(), [destroyPlayer]);

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
    if (p) { try { p.volume = localMuted ? 0 : volumeGain(volume); } catch {} }
  }, [volume, localMuted]);

  // One timer: drift, end-of-song, and stream credit all need the same reading.
  useEffect(() => {
    if (!state.track) return;
    const iv = setInterval(() => {
      const s = stateRef.current;
      if (!s.track) return;
      const want = radioPositionMs(s, skewRef.current);
      const p = playerRef.current;

      if (isHost && !s.paused) {
        // `posts.duration_seconds` is not always populated, and a null there
        // would mean a song that plays to the end and then sits there forever
        // with the running order untouched. The loaded player knows the real
        // length — use it when the row does not.
        const known = s.track.durationMs ?? ((p?.duration ?? 0) * 1000 || null);
        if (known && want >= known - 250) { next(); return; }
      }

      if (!p || s.paused) return;
      let have = 0;
      try { have = (p.currentTime ?? 0) * 1000; } catch { return; }

      // Stream credit — genuine forward listening only, so seeks and the
      // end-of-track jump never buy a credit.
      const delta = have - lastPosRef.current;
      lastPosRef.current = have;
      if (delta > 0 && delta < MAX_GENUINE_DELTA_MS) {
        heardMsRef.current += delta;
        const id = s.track.id;
        if (viewerId && creditedRef.current !== id
            && heardMsRef.current >= streamCreditAtMs(s.track.durationMs)) {
          creditedRef.current = id;
          void recordStream(viewerId, id, deviceIdRef.current);
        }
      }

      // A player still buffering reports 0 — seeking on that fights the load.
      if (have > 250 && Math.abs(have - want) > DRIFT_TOLERANCE_MS) {
        try { p.seekTo(want / 1000); } catch {}
      }
    }, TICK_MS);
    return () => clearInterval(iv);
  }, [state.track, isHost, next, viewerId]);

  // Host heartbeat: re-announce so a dropped packet heals itself.
  useEffect(() => {
    if (!isHost || !ready) return;
    const iv = setInterval(() => {
      const s = stateRef.current;
      publish?.({ track: s.track, startedAt: s.startedAt, positionMs: s.positionMs, paused: s.paused });
    }, RADIO_HEARTBEAT_MS);
    return () => clearInterval(iv);
  }, [isHost, ready, publish]);

  const answerRequest = useCallback(() => {
    if (!isHost) return;
    const s = stateRef.current;
    publish?.({ track: s.track, startedAt: s.startedAt, positionMs: s.positionMs, paused: s.paused });
  }, [isHost, publish]);

  const askedRef = useRef(false);
  useEffect(() => {
    if (isHost || !ready || askedRef.current) return;
    askedRef.current = true;
    request?.();
  }, [isHost, ready, request]);

  const upNext = index >= 0 ? list.slice(index + 1) : [];
  return {
    state, list, index, upNext,
    volume, setVolume, localMuted, setLocalMuted,
    applyRemote, answerRequest,
    playList, playTrack, pause, resume, stop, next, previous, enqueue, removeQueued,
    hasPrevious: index > 0,
    hasNext: index >= 0 && index < list.length - 1,
    positionMs: () => radioPositionMs(stateRef.current, skewRef.current),
  };
}
