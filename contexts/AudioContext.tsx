import React, { createContext, useContext, useState, useRef, useEffect } from 'react';
import { Audio } from 'expo-av';
import { supabase } from '../lib/supabase';

const AUDIO_MODE = {
  allowsRecordingIOS: false,
  playsInSilentModeIOS: true,
  staysActiveInBackground: true,
  shouldDuckAndroid: true,
  playThroughEarpieceAndroid: false,
};

// Streams are credited by CUMULATIVE listen time, scaled by the track's duration
// so short audio can't rack up streams unfairly vs. long audio. Returns how many
// listen-seconds are needed to credit the 1st and the 2nd stream:
//
//   ≤10s : 1st = 80% of duration,  2nd = 30s combined
//   ≤30s : 1st = 70% of duration,  2nd = 60s combined
//   ≤60s : 1st = 60% of duration,  2nd = 80% of duration combined
//   >60s : 1st = 15s,              2nd = 70% of duration combined
//
// A first stream always needs at least 5s of listening (global floor); paired
// with the 5s minimum upload length, this keeps every track on fair footing.
function streamThresholds(durationSec: number): { t1: number; t2: number } {
  let t1: number, t2: number;
  if (durationSec <= 10)      { t1 = 0.8 * durationSec; t2 = 30; }
  else if (durationSec <= 30) { t1 = 0.7 * durationSec; t2 = 60; }
  else if (durationSec <= 60) { t1 = 0.6 * durationSec; t2 = 0.8 * durationSec; }
  else                        { t1 = 15;                t2 = 0.7 * durationSec; }
  return { t1: Math.max(5, t1), t2 };
}

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
  // Per-post stream accounting for this app session (keyed by post id):
  //   listenMs        – cumulative genuine forward listen time (across replays)
  //   streamsAwarded  – streams already credited via listening (0, 1, or 2)
  const listenMsRef = useRef<Record<string, number>>({});
  const streamsAwardedRef = useRef<Record<string, number>>({});

  // Configure the audio session once up front so the first tap plays immediately
  // (a cold session previously made the first createAsync fail to start).
  useEffect(() => { Audio.setAudioModeAsync(AUDIO_MODE).catch(() => {}); }, []);

  async function stop() {
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
      try { canCount = !!(await supabase.auth.getUser()).data.user; } catch {}
    })();
    const recordStream = () => {
      supabase.rpc('record_stream', { p_post_id: track.id }).then(undefined, () => {});
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
            const id = track.id;
            const listened = (listenMsRef.current[id] || 0) + delta;
            listenMsRef.current[id] = listened;
            const awarded = streamsAwardedRef.current[id] || 0;
            const { t1, t2 } = streamThresholds(dur / 1000);
            if (awarded === 0 && listened >= t1 * 1000) {
              streamsAwardedRef.current[id] = 1;
              recordStream();
            } else if (awarded === 1 && listened >= t2 * 1000) {
              streamsAwardedRef.current[id] = 2;
              recordStream();
            }
          }
        }
        lastPosMs = pos;

        if (status.didJustFinish) {
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
