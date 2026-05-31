import React, { createContext, useContext, useEffect, useState } from 'react';
import TrackPlayer, {
  Capability,
  State,
  usePlaybackState,
  useProgress,
  useActiveTrack,
} from 'react-native-track-player';

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

let playerReady = false;

async function ensurePlayer() {
  if (playerReady) return;
  try {
    await TrackPlayer.setupPlayer({ autoHandleInterruptions: true });
    await TrackPlayer.updateOptions({
      capabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.Stop,
        Capability.SeekTo,
      ],
      compactCapabilities: [Capability.Play, Capability.Pause, Capability.Stop],
      notificationCapabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.Stop,
        Capability.SeekTo,
      ],
    });
    playerReady = true;
  } catch {
    // Already set up — this is fine
    playerReady = true;
  }
}

export function AudioProvider({ children }: { children: React.ReactNode }) {
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const playbackState = usePlaybackState();
  const { position, duration } = useProgress(250);
  const activeTrack = useActiveTrack();

  useEffect(() => {
    ensurePlayer();
  }, []);

  useEffect(() => {
    if (!activeTrack) setCurrentTrack(null);
  }, [activeTrack]);

  const state = playbackState?.state;
  const isPlaying = state === State.Playing;
  const isBuffering = state === State.Buffering || state === State.Loading;

  async function play(track: Track) {
    await ensurePlayer();

    // Toggle pause/play if same track
    if (activeTrack?.id === track.id) {
      isPlaying ? await TrackPlayer.pause() : await TrackPlayer.play();
      return;
    }

    await TrackPlayer.reset();
    await TrackPlayer.add({
      id: track.id,
      url: track.uri,
      title: track.caption || 'Audio Track',
      artist: track.artist,
    });
    await TrackPlayer.play();
    setCurrentTrack(track);
  }

  async function stop() {
    await TrackPlayer.reset();
    setCurrentTrack(null);
  }

  async function seekTo(ms: number) {
    await TrackPlayer.seekTo(ms / 1000);
  }

  return (
    <AudioContext.Provider value={{
      currentTrack: activeTrack ? currentTrack : null,
      isPlaying,
      isBuffering,
      positionMs: position * 1000,
      durationMs: duration * 1000,
      play,
      stop,
      seekTo,
    }}>
      {children}
    </AudioContext.Provider>
  );
}

export function useAudio() {
  const ctx = useContext(AudioContext);
  if (!ctx) throw new Error('useAudio must be used within AudioProvider');
  return ctx;
}
