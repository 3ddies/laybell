import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import { getDeviceId } from '../lib/deviceId';
import { useAudio } from './AudioContext';

// Ambient post music: plays the attached song of the currently-FOCUSED image/video
// post or story (separate from the main mini-player). Looping, with a global mute
// toggle (the sound circle button). It DEFERS to the main player — if the user is
// listening to a track in the mini-player, ambient stays silent so their music
// isn't interrupted; tapping a post's song name promotes it to the main player.
//
// Ambient stream crediting (its own ecosystem — see record_ambient_stream_rpc.sql):
// because this listening is often unintentional (autoplay while scrolling), it does
// NOT use the regular duration-scaled rules. Instead, 30s of GENUINE, UNMUTED,
// foreground listening — accumulated PER SONG across every post/story that uses it,
// over a rolling 24h window — credits exactly ONE stream for that song. It stacks
// on top of the regular up-to-3 (which only apply when the song is tapped/promoted
// to the main player). Muted time, background time, and the loop seam never count.

const AMBIENT_THRESHOLD_MS = 30_000;            // 30s of genuine listening → 1 stream
const AMBIENT_WINDOW_MS = 24 * 60 * 60 * 1000;  // per-song cap window (matches the rest)
const AMBIENT_KEY = 'ambient_stream_progress_v1';

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

  const soundRef = useRef<AudioPlayer | null>(null);
  const statusSubRef = useRef<{ remove: () => void } | null>(null);
  const tokenRef = useRef(0);
  const activeIdRef = useRef<string | null>(null);
  const activeSongRef = useRef<string | null>(null);
  const mutedRef = useRef(false); mutedRef.current = muted;
  const mainPlayingRef = useRef(false); mainPlayingRef.current = mainPlaying;
  const urlCache = useRef<Map<string, string>>(new Map()).current;

  // ─── ambient stream accounting (per song, rolling 24h window) ────────────────
  // ms       – cumulative genuine unmuted foreground listen time for the song
  // credited – whether this song's 1 ambient stream has already been earned
  // windowStart – epoch ms the song's current 24h window began
  const ambientMsRef = useRef<Record<string, number>>({});
  const ambientCreditedRef = useRef<Record<string, boolean>>({});
  const ambientWindowRef = useRef<Record<string, number>>({});
  const uidRef = useRef<string | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const appActiveRef = useRef(true); // only foreground listening counts

  // Resolve the device id (for the per-device anti-farm cap).
  useEffect(() => { getDeviceId().then((id) => { deviceIdRef.current = id; }).catch(() => {}); }, []);

  // Resolve the user and restore any in-progress (non-expired) per-song accrual so a
  // force-quit can't reset the 30s toward a stream or re-earn an already-credited one.
  useEffect(() => {
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        uidRef.current = user?.id ?? null;
        if (!user) return;
        const raw = await AsyncStorage.getItem(`${AMBIENT_KEY}_${user.id}`);
        if (!raw) return;
        const map = JSON.parse(raw) as Record<string, { ms: number; credited: boolean; ts: number }>;
        const now = Date.now();
        for (const [sid, e] of Object.entries(map)) {
          if (e && now - e.ts < AMBIENT_WINDOW_MS) {
            ambientMsRef.current[sid] = e.ms;
            ambientCreditedRef.current[sid] = e.credited;
            ambientWindowRef.current[sid] = e.ts;
          }
        }
      } catch {}
    })();
  }, []);

  // Background time must not count — pause accrual when the app isn't foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      appActiveRef.current = s === 'active';
      if (s !== 'active') saveAmbient();
    });
    return () => sub.remove();
  }, []);

  function saveAmbient() {
    const uid = uidRef.current;
    if (!uid) return;
    try {
      const now = Date.now();
      const out: Record<string, { ms: number; credited: boolean; ts: number }> = {};
      for (const sid of Object.keys(ambientMsRef.current)) {
        const ts = ambientWindowRef.current[sid] ?? now;
        if (now - ts < AMBIENT_WINDOW_MS) {
          out[sid] = { ms: ambientMsRef.current[sid] || 0, credited: !!ambientCreditedRef.current[sid], ts };
        }
      }
      AsyncStorage.setItem(`${AMBIENT_KEY}_${uid}`, JSON.stringify(out)).catch(() => {});
    } catch {}
  }

  // Add `deltaMs` of genuine listening to `songId`; credit its single ambient stream
  // once cumulative listening crosses 30s. Resets the song's tally when its 24h
  // window elapses so a genuine listener can earn again the next day.
  function accrueAmbient(songId: string, deltaMs: number) {
    const now = Date.now();
    const ws = ambientWindowRef.current[songId];
    if (ws == null || now - ws >= AMBIENT_WINDOW_MS) {
      ambientWindowRef.current[songId] = now;
      ambientMsRef.current[songId] = 0;
      ambientCreditedRef.current[songId] = false;
    }
    if (ambientCreditedRef.current[songId]) return; // already earned this window
    const ms = (ambientMsRef.current[songId] || 0) + deltaMs;
    ambientMsRef.current[songId] = ms;
    if (ms >= AMBIENT_THRESHOLD_MS) {
      ambientCreditedRef.current[songId] = true;
      // Server is authoritative (no self-streams, per-user/device caps). Fire-and-forget.
      supabase.rpc('record_ambient_stream', { p_song_id: songId, p_device_id: deviceIdRef.current }).then(undefined, () => {});
      saveAmbient();
    }
  }

  function teardown() {
    statusSubRef.current?.remove(); statusSubRef.current = null;
    const s = soundRef.current;
    soundRef.current = null;
    if (s) { try { s.pause(); } catch {} setTimeout(() => { try { s.remove(); } catch {} }, 0); }
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

    statusSubRef.current?.remove(); statusSubRef.current = null;
    const existing = soundRef.current;
    soundRef.current = null;
    if (existing) { try { existing.pause(); } catch {} setTimeout(() => { try { existing.remove(); } catch {} }, 0); }
    if (token !== tokenRef.current) return;

    try {
      // createAudioPlayer is synchronous (we token-checked above); loop + mute are
      // native, writable properties in expo-audio.
      const player = createAudioPlayer({ uri: url }, { updateInterval: 500 });
      player.loop = true;
      player.muted = mutedRef.current;
      soundRef.current = player;
      // Accrue genuine forward listen time for this song toward the 30s → 1 ambient
      // stream. `lastPos` is per-sound, so reloading on a scroll to another post with
      // the same song starts fresh while the PER-SONG tally persists; the loop seam
      // reads as a negative/large jump and is ignored, as is muted/background time.
      let lastPos = 0;
      statusSubRef.current = player.addListener('playbackStatusUpdate', (st: any) => {
        if (!st.isLoaded) return;
        const pos = (st.currentTime ?? 0) * 1000;   // expo-audio reports SECONDS
        const delta = pos - lastPos;
        lastPos = pos;
        if (delta > 0 && delta < 1500 && !mutedRef.current && appActiveRef.current) accrueAmbient(songId, delta);
      });
      player.play();
    } catch {}
  }

  function toggleMuted() {
    setMuted((m) => {
      const next = !m;
      try { if (soundRef.current) soundRef.current.muted = next; } catch {}
      return next;
    });
  }

  // When the main player starts (e.g. the user tapped a song name → it's promoted),
  // stop ambient so the two don't overlap.
  useEffect(() => { if (mainPlaying) stop(); /* eslint-disable-next-line */ }, [mainPlaying]);

  // Tidy up on unmount — persist ambient progress first so nothing is lost.
  useEffect(() => () => { saveAmbient(); teardown(); }, []);

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
