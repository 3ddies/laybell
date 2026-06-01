import React, { createContext, useContext, useState, useRef } from 'react';
import { Audio } from 'expo-av';
import { supabase } from '../lib/supabase';

export type Track = {
  id: string;
  uri: string;
  caption: string;
  artist: string;
};

type AudioContextType = {
  currentTrack: Track | null;
  isPlaying: boolean;
  isBuffering: boolean;
  positionMs: number;
  durationMs: number;
  play: (track: Track) => Promise<void>;
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

  async function seekTo(ms: number) {
    if (soundRef.current) {
      await soundRef.current.setPositionAsync(ms);
      setPositionMs(ms);
    }
  }

  async function play(track: Track) {
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
    let canCount = false;
    let requiresFull = false;
    let streamCounted = false;
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
    const recordStream = () => {
      streamCounted = true; // set guard before await so rapid updates don't double-fire
      supabase.from('streams').insert({ post_id: track.id }).then(undefined, () => {});
    };

    try {
      const { sound } = await Audio.Sound.createAsync(
        { uri: track.uri },
        { shouldPlay: true }
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
          setIsPlaying(false);
          setIsBuffering(false);
          setCurrentTrack(null);
          setPositionMs(0);
          setDurationMs(0);
          soundRef.current = null;
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
    <AudioContext.Provider value={{ currentTrack, isPlaying, isBuffering, positionMs, durationMs, play, stop, seekTo }}>
      {children}
    </AudioContext.Provider>
  );
}

export function useAudio() {
  const ctx = useContext(AudioContext);
  if (!ctx) throw new Error('useAudio must be used within AudioProvider');
  return ctx;
}
