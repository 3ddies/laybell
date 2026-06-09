import React, { createContext, useContext, useState, useRef, useEffect } from 'react';
import { Audio } from 'expo-av';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import { getDeviceId } from '../lib/deviceId';
import { playThresholds } from '../lib/playThresholds';
import { bumpBadge } from '../lib/badges';

// Per-post listen progress persists for a rolling 24h window (matches the
// server's per-user/post stream cap) so force-quitting can't reset it.
const STREAM_PROGRESS_KEY = 'stream_progress_v1';
const STREAM_WINDOW_MS = 24 * 60 * 60 * 1000;

const AUDIO_MODE = {
  allowsRecordingIOS: false,
  playsInSilentModeIOS: true,
  staysActiveInBackground: true,
  shouldDuckAndroid: true,
  playThroughEarpieceAndroid: false,
};

export type Track = {
  id: string;
  uri: string;
  caption: string;
  artist: string;
  cover?: string | null;
};

type AudioContextType = {
  currentTrack: Track | null;
  isPlaying: boolean;
  isBuffering: boolean;
  positionMs: number;
  durationMs: number;
  play: (track: Track) => Promise<void>;
  playQueue: (tracks: Track[], startIndex?: number) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  seekTo: (ms: number) => Promise<void>;
  expanded: boolean;
  expand: () => void;
  collapse: () => void;
  next: () => void;
  previous: () => void;
  queueIndex: number;
  queueLength: number;
  videoMuted: boolean;
  toggleVideoMuted: () => void;
};

const AudioContext = createContext<AudioContextType | null>(null);

export function AudioProvider({ children }: { children: React.ReactNode }) {
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const expand = () => setExpanded(true);
  const collapse = () => setExpanded(false);
  // Feed video audio. ON at app open; auto-muted once a song plays (no overlap).
  const [videoMuted, setVideoMuted] = useState(false);
  const soundRef = useRef<Audio.Sound | null>(null);
  const queueRef = useRef<Track[]>([]);
  const queueIndexRef = useRef(0);
  const playTokenRef = useRef(0); // guards against overlapping plays (rapid next/prev)
  const [queueIndex, setQueueIndex] = useState(0);
  const [queueLength, setQueueLength] = useState(0);
  // Per-post stream accounting, persisted for a rolling 24h window (keyed by post id):
  //   listenMs        – cumulative genuine forward listen time (across replays)
  //   streamsAwarded  – streams already credited via listening (0, 1, or 2)
  //   windowStart     – epoch ms the current 24h window began for this post
  const listenMsRef = useRef<Record<string, number>>({});
  const streamsAwardedRef = useRef<Record<string, number>>({});
  const windowStartRef = useRef<Record<string, number>>({});
  const uidRef = useRef<string | null>(null);
  const deviceIdRef = useRef<string | null>(null); // per-install id for the device cap
  // Genuine forward listen ms accrued toward the daily "music streaming" badge —
  // a SEPARATE accumulator from the per-post stream credit (listenMsRef), so it
  // sums across posts and isn't tied to any 24h per-post window. Flushed as whole
  // seconds via record_badge_activity (keeping the sub-second remainder → no drift).
  const badgeMsRef = useRef(0);

  // Configure the audio session once up front so the first tap plays immediately
  // (a cold session previously made the first createAsync fail to start).
  useEffect(() => { Audio.setAudioModeAsync(AUDIO_MODE).catch(() => {}); }, []);

  // Resolve the device id once so it's ready to attach to stream records.
  useEffect(() => { getDeviceId().then((id) => { deviceIdRef.current = id; }).catch(() => {}); }, []);

  // Restore persisted per-post listen progress (within its 24h window) so a
  // force-quit can't reset cumulative listen time and re-earn streams.
  useEffect(() => {
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        uidRef.current = user?.id ?? null;
        if (!user) return;
        const raw = await AsyncStorage.getItem(`${STREAM_PROGRESS_KEY}_${user.id}`);
        if (!raw) return;
        const map = JSON.parse(raw) as Record<string, { ms: number; awarded: number; ts: number }>;
        const now = Date.now();
        for (const [pid, e] of Object.entries(map)) {
          if (e && now - e.ts < STREAM_WINDOW_MS) {
            listenMsRef.current[pid] = e.ms;
            streamsAwardedRef.current[pid] = e.awarded;
            windowStartRef.current[pid] = e.ts;
          }
        }
      } catch {}
    })();
  }, []);

  // Flush whole accrued listen-seconds to the badge counter (keeps the sub-second
  // remainder so repeated flushes never drift or double-count). Called periodically
  // while playing and on pause/stop/finish so trailing seconds aren't lost.
  function flushBadgeMs() {
    const secs = Math.floor(badgeMsRef.current / 1000);
    if (secs <= 0) return;
    badgeMsRef.current -= secs * 1000;
    if (uidRef.current) bumpBadge('music_seconds', secs);
  }

  // Persist the (non-expired) per-post progress. Called on credit/pause/stop/end,
  // not every tick, to limit writes.
  function saveProgress() {
    const uid = uidRef.current;
    if (!uid) return;
    try {
      const now = Date.now();
      const out: Record<string, { ms: number; awarded: number; ts: number }> = {};
      for (const pid of Object.keys(listenMsRef.current)) {
        const ts = windowStartRef.current[pid] ?? now;
        if (now - ts < STREAM_WINDOW_MS) {
          out[pid] = { ms: listenMsRef.current[pid] || 0, awarded: streamsAwardedRef.current[pid] || 0, ts };
        }
      }
      AsyncStorage.setItem(`${STREAM_PROGRESS_KEY}_${uid}`, JSON.stringify(out)).catch(() => {});
    } catch {}
  }

  async function stop() {
    saveProgress();
    flushBadgeMs();
    playTokenRef.current++; // cancel any in-flight load
    if (soundRef.current) {
      await soundRef.current.stopAsync();
      await soundRef.current.unloadAsync();
      soundRef.current = null;
    }
    setExpanded(false);
    setIsPlaying(false);
    setIsBuffering(false);
    setCurrentTrack(null);
    setPositionMs(0);
    setDurationMs(0);
  }

  async function pause() {
    if (soundRef.current) {
      await soundRef.current.pauseAsync();
      setIsPlaying(false);
      saveProgress();
      flushBadgeMs();
    }
  }

  async function resume() {
    if (soundRef.current) {
      await soundRef.current.playAsync();
      setIsPlaying(true);
    }
  }

  // Tap a video's audio button: turning video audio ON pauses the song so they
  // don't overlap; turning it off just mutes the video.
  function toggleVideoMuted() {
    if (videoMuted) {
      if (isPlaying) pause();
      setVideoMuted(false);
    } else {
      setVideoMuted(true);
    }
  }

  async function seekTo(ms: number) {
    if (soundRef.current) {
      setPositionMs(ms); // reflect immediately so the scrubber doesn't snap back
      await soundRef.current.setPositionAsync(ms);
    }
  }

  async function playQueue(tracks: Track[], startIndex = 0) {
    if (!tracks.length) return;
    queueRef.current = tracks;
    queueIndexRef.current = startIndex;
    setQueueLength(tracks.length);
    setQueueIndex(startIndex);
    await play(tracks[startIndex], true);
  }

  function next() {
    const q = queueRef.current;
    const ni = queueIndexRef.current + 1;
    if (q.length && ni < q.length) {
      queueIndexRef.current = ni;
      setQueueIndex(ni);
      play(q[ni], true);
    }
  }

  function previous() {
    const q = queueRef.current;
    const pi = queueIndexRef.current - 1;
    if (q.length && pi >= 0) {
      queueIndexRef.current = pi;
      setQueueIndex(pi);
      play(q[pi], true);
    }
  }

  async function play(track: Track, fromQueue = false) {
    if (!fromQueue) { queueRef.current = []; queueIndexRef.current = 0; setQueueLength(0); setQueueIndex(0); }
    if (currentTrack?.id === track.id && isPlaying) {
      await stop();
      return;
    }

    // Each play gets a token; if a newer play starts before this one finishes
    // loading, the older one bails and unloads itself (prevents overlap).
    const token = ++playTokenRef.current;

    // Tear down the existing sound (grab+null first so concurrent calls don't double-unload).
    const existing = soundRef.current;
    soundRef.current = null;
    if (existing) {
      try { await existing.stopAsync(); await existing.unloadAsync(); } catch {}
    }

    setCurrentTrack(track);
    setIsPlaying(true);
    setIsBuffering(true);
    setPositionMs(0);
    setDurationMs(0);
    setVideoMuted(true); // a song is playing → mute feed video to avoid overlap

    // --- Stream counting policy ---
    // Credit streams by cumulative listen time, scaled by duration (see
    // streamThresholds): the 1st stream at the tier's 1st threshold, the 2nd once
    // combined listening reaches the 2nd threshold. Genuine forward listen time is
    // accumulated per post across replays this session. The server (record_stream)
    // still enforces no self-streams and the 10-per-24h per-user cap.
    // canCount is resolved in the background so playback never waits on the network.
    let canCount = false;
    (async () => {
      try {
        const u = (await supabase.auth.getUser()).data.user;
        canCount = !!u;
        if (u) uidRef.current = u.id;
      } catch {}
    })();
    const recordStream = () => {
      supabase.rpc('record_stream', { p_post_id: track.id, p_device_id: deviceIdRef.current }).then(undefined, () => {});
    };
    let lastPosMs = 0; // previous reported position, for forward-delta accumulation

    try {
      // Load PAUSED — a superseded sound must never start, so we only call
      // playAsync() on the one that survives the token check below.
      const { sound } = await Audio.Sound.createAsync(
        { uri: track.uri },
        { shouldPlay: false, progressUpdateIntervalMillis: 250 },
      );
      // A newer play started while this was loading → discard this sound, don't overlap.
      if (token !== playTokenRef.current) {
        try { await sound.unloadAsync(); } catch {}
        return;
      }
      soundRef.current = sound;
      sound.playAsync().catch(() => {});

      sound.setOnPlaybackStatusUpdate((status: any) => {
        if (!status.isLoaded) return;
        const pos = status.positionMillis ?? 0;
        const dur = status.durationMillis ?? 0;
        setPositionMs(pos);
        setDurationMs(dur);
        setIsBuffering(status.isBuffering ?? false);

        // Accumulate genuine forward listen time (ignore seeks, rewinds and the
        // jump on finish), then credit the 1st/2nd stream as cumulative listening
        // crosses this track's duration-scaled thresholds.
        if (canCount && dur > 0) {
          const delta = pos - lastPosMs;
          if (delta > 0 && delta < 1500) {
            // Daily music badge: accrue this genuine forward delta (across all
            // posts, independent of the per-post stream window) and flush in chunks.
            badgeMsRef.current += delta;
            if (badgeMsRef.current >= 15000) flushBadgeMs();
            const id = track.id;
            // Reset a post's accounting once its 24h window elapses so a genuine
            // listener can earn again the next day (mirrors the server cap window).
            const ws = windowStartRef.current[id];
            if (ws == null || Date.now() - ws >= STREAM_WINDOW_MS) {
              windowStartRef.current[id] = Date.now();
              listenMsRef.current[id] = 0;
              streamsAwardedRef.current[id] = 0;
            }
            const listened = (listenMsRef.current[id] || 0) + delta;
            listenMsRef.current[id] = listened;
            const awarded = streamsAwardedRef.current[id] || 0;
            const { t1, t2, t3 } = playThresholds(dur / 1000);
            if (awarded === 0 && listened >= t1 * 1000) {
              streamsAwardedRef.current[id] = 1;
              recordStream();
              saveProgress();
            } else if (awarded === 1 && listened >= t2 * 1000) {
              streamsAwardedRef.current[id] = 2;
              recordStream();
              saveProgress();
            } else if (awarded === 2 && listened >= t3 * 1000) {
              // 3rd stream — credited by the server only for accounts >24h old.
              streamsAwardedRef.current[id] = 3;
              recordStream();
              saveProgress();
            }
          }
        }
        lastPosMs = pos;

        if (status.didJustFinish) {
          saveProgress();
          flushBadgeMs();
          const q = queueRef.current;
          const next = queueIndexRef.current + 1;
          if (q.length && next < q.length) {
            // Auto-advance to the next track in the queue
            queueIndexRef.current = next;
            setQueueIndex(next);
            soundRef.current = null;
            play(q[next], true);
          } else {
            setIsPlaying(false);
            setIsBuffering(false);
            setCurrentTrack(null);
            setPositionMs(0);
            setDurationMs(0);
            soundRef.current = null;
            queueRef.current = [];
            queueIndexRef.current = 0;
            setQueueLength(0);
            setQueueIndex(0);
          }
        }
      });
    } catch (err) {
      console.log('audio error:', err);
      setIsPlaying(false);
      setIsBuffering(false);
      setCurrentTrack(null);
    }
  }

  return (
    <AudioContext.Provider value={{ currentTrack, isPlaying, isBuffering, positionMs, durationMs, play, playQueue, pause, resume, stop, seekTo, expanded, expand, collapse, next, previous, queueIndex, queueLength, videoMuted, toggleVideoMuted }}>
      {children}
    </AudioContext.Provider>
  );
}

export function useAudio() {
  const ctx = useContext(AudioContext);
  if (!ctx) throw new Error('useAudio must be used within AudioProvider');
  return ctx;
}
