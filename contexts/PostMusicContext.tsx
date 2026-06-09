import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Audio } from 'expo-av';
import { supabase } from '../lib/supabase';
import { useAudio } from './AudioContext';

// Ambient post music: plays the attached song of the currently-FOCUSED image/video
// post or story (separate from the main mini-player). Looping, with a global mute
// toggle (the sound circle button). It DEFERS to the main player — if the user is
// listening to a track in the mini-player, ambient stays silent so their music
// isn't interrupted; tapping a post's song name promotes it to the main player.

type PostMusicType = {
  activeId: string | null;          // host post/story id whose song is playing
  muted: boolean;
  toggleMuted: () => void;
  // Play `songId`'s audio for host `hostId`. mediaUrl optional (resolved + cached).
  playSong: (hostId: string, songId: string, mediaUrl?: string | null) => void;
  stop: (hostId?: string) => void;  // stop (optionally only if hostId is the active one)
};

const Ctx = createContext<PostMusicType | null>(null);

export function PostMusicProvider({ children }: { children: React.ReactNode }) {
  const { isPlaying: mainPlaying } = useAudio();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);

  const soundRef = useRef<Audio.Sound | null>(null);
  const tokenRef = useRef(0);
  const activeIdRef = useRef<string | null>(null);
  const activeSongRef = useRef<string | null>(null);
  const mutedRef = useRef(false); mutedRef.current = muted;
  const mainPlayingRef = useRef(false); mainPlayingRef.current = mainPlaying;
  const urlCache = useRef<Map<string, string>>(new Map()).current;

  async function teardown() {
    const s = soundRef.current;
    soundRef.current = null;
    if (s) { try { await s.stopAsync(); await s.unloadAsync(); } catch {} }
  }

  function stop(hostId?: string) {
    if (hostId && activeIdRef.current !== hostId) return;
    tokenRef.current++; // cancel any in-flight load
    activeIdRef.current = null;
    activeSongRef.current = null;
    setActiveId(null);
    teardown();
  }

  async function playSong(hostId: string, songId: string, mediaUrl?: string | null) {
    // Don't fight the user's chosen track in the mini-player.
    if (mainPlayingRef.current) { stop(); return; }
    if (activeIdRef.current === hostId && activeSongRef.current === songId && soundRef.current) return;

    const token = ++tokenRef.current;
    activeIdRef.current = hostId;
    activeSongRef.current = songId;
    setActiveId(hostId);

    let url = mediaUrl ?? urlCache.get(songId) ?? null;
    if (!url) {
      const { data } = await supabase.from('posts').select('media_url').eq('id', songId).single();
      url = (data as any)?.media_url ?? null;
      if (url) urlCache.set(songId, url);
    }
    if (!url || token !== tokenRef.current) return;

    const existing = soundRef.current;
    soundRef.current = null;
    if (existing) { try { await existing.stopAsync(); await existing.unloadAsync(); } catch {} }
    if (token !== tokenRef.current) return;

    try {
      const { sound } = await Audio.Sound.createAsync(
        { uri: url },
        { shouldPlay: false, isLooping: true, isMuted: mutedRef.current },
      );
      if (token !== tokenRef.current) { try { await sound.unloadAsync(); } catch {} return; }
      soundRef.current = sound;
      sound.playAsync().catch(() => {});
    } catch {}
  }

  function toggleMuted() {
    setMuted((m) => {
      const next = !m;
      soundRef.current?.setIsMutedAsync(next).catch(() => {});
      return next;
    });
  }

  // When the main player starts (e.g. the user tapped a song name → it's promoted),
  // stop ambient so the two don't overlap.
  useEffect(() => { if (mainPlaying) stop(); /* eslint-disable-next-line */ }, [mainPlaying]);

  // Tidy up on unmount.
  useEffect(() => () => { teardown(); }, []);

  return (
    <Ctx.Provider value={{ activeId, muted, toggleMuted, playSong, stop }}>
      {children}
    </Ctx.Provider>
  );
}

export function usePostMusic() {
  const c = useContext(Ctx);
  if (!c) throw new Error('usePostMusic must be used within PostMusicProvider');
  return c;
}
