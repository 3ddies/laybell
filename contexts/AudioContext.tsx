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
  const soundRef = useRef<Audio.Sound | null>(null);
  const queueRef = useRef<Track[]>([]);
  const queueIndexRef = useRef(0);
  const playTokenRef = useRef(0); // guards against overlapping plays (rapid next/prev)
  const [queueIndex, setQueueIndex] = useState(0);
  const [queueLength, setQueueLength] = useState(0);

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

    // --- Stream counting policy ---
    // First counted listen of a song triggers at 10%; every later listen must
    // reach 100%. Prevents stream spam while still crediting genuine replays.
    // NOTE: determined in the background so playback never waits on the network
    // (gating on auth/db here made the first tap glitch while the session was cold).
    let canCount = false;
    let requiresFull = false;
    let streamCounted = false;
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          canCount = true;
          const { count } = await supabase
            .from('streams')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', user.id).eq('post_id', track.id);
          requiresFull = (count || 0) > 0;
        }
      } catch {}
    })();
    const recordStream = () => {
      streamCounted = true; // set guard before await so rapid updates don't double-fire
      // Server enforces no-self-streams and the 10-per-24h per-user cap.
      supabase.rpc('record_stream', { p_post_id: track.id }).then(undefined, () => {});
    };

    try {
      const { sound } = await Audio.Sound.createAsync(
        { uri: track.uri },
        { shouldPlay: true, progressUpdateIntervalMillis: 250 } // smoother scrubber updates
      );
      // A newer play started while this was loading → discard this sound, don't overlap.
      if (token !== playTokenRef.current) {
        try { await sound.unloadAsync(); } catch {}
        return;
      }
      soundRef.current = sound;
      sound.playAsync().catch(() => {}); // ensure it starts even if the first load didn't auto-play

      sound.setOnPlaybackStatusUpdate((status: any) => {
        if (!status.isLoaded) return;
        setPositionMs(status.positionMillis ?? 0);
        setDurationMs(status.durationMillis ?? 0);
        setIsBuffering(status.isBuffering ?? false);

        // Count a stream once the listen threshold is crossed.
        if (canCount && !streamCounted) {
          const dur = status.durationMillis ?? 0;
          const pos = status.positionMillis ?? 0;
          if (requiresFull) {
            if (status.didJustFinish) recordStream();
          } else if (dur > 0 && pos / dur >= 0.1) {
            recordStream();
          }
        }

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
    <AudioContext.Provider value={{ currentTrack, isPlaying, isBuffering, positionMs, durationMs, play, playQueue, pause, resume, stop, seekTo, expanded, expand, collapse, next, previous, queueIndex, queueLength }}>
      {children}
    </AudioContext.Provider>
  );
}

export function useAudio() {
  const ctx = useContext(AudioContext);
  if (!ctx) throw new Error('useAudio must be used within AudioProvider');
  return ctx;
}
