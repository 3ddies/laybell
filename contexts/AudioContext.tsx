import React, { createContext, useContext, useState, useRef } from 'react';
import { Audio } from 'expo-av';
import { supabase } from '../lib/supabase';

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
};

const AudioContext = createContext<AudioContextType | null>(null);

export function AudioProvider({ children }: { children: React.ReactNode }) {
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const soundRef = useRef<Audio.Sound | null>(null);
  const queueRef = useRef<Track[]>([]);
  const queueIndexRef = useRef(0);

  async function stop() {
    if (soundRef.current) {
      await soundRef.current.stopAsync();
      await soundRef.current.unloadAsync();
      soundRef.current = null;
    }
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
    await play(tracks[startIndex], true);
  }

  async function play(track: Track, fromQueue = false) {
    if (!fromQueue) { queueRef.current = []; queueIndexRef.current = 0; }
    if (currentTrack?.id === track.id && isPlaying) {
      await stop();
      return;
    }

    if (soundRef.current) {
      await soundRef.current.stopAsync();
      await soundRef.current.unloadAsync();
      soundRef.current = null;
    }

    setCurrentTrack(track);
    setIsPlaying(true);
    setIsBuffering(true);
    setPositionMs(0);
    setDurationMs(0);

    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    });

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
      soundRef.current = sound;

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
    <AudioContext.Provider value={{ currentTrack, isPlaying, isBuffering, positionMs, durationMs, play, playQueue, pause, resume, stop, seekTo }}>
      {children}
    </AudioContext.Provider>
  );
}

export function useAudio() {
  const ctx = useContext(AudioContext);
  if (!ctx) throw new Error('useAudio must be used within AudioProvider');
  return ctx;
}
