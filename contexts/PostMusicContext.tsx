import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import { getDeviceId } from '../lib/deviceId';
import { useAudio } from './AudioContext';
import { useMediaSuspend } from './MediaSuspendContext';

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

type PostMusicActions = {
  toggleMuted: () => void;
  // Play `songId`'s audio for host `hostId`. mediaUrl optional (resolved + cached).
  playSong: (hostId: string, songId: string, mediaUrl?: string | null) => void;
  stop: (hostId?: string) => void;  // stop (optionally only if hostId is the active one)
  // Resolve + cache the song's audio URL WITHOUT touching playback — feeds call
  // this as a music post approaches so playSong at scroll-rest never waits on
  // the network.
  prefetchSong: (songId: string, mediaUrl?: string | null) => void;
  // Pre-create the session's ONE ambient player at a safe idle moment (the
  // feed gate) so the first song tap never pays a native player construction.
  warmSongPlayer: () => void;
};
type PostMusicType = PostMusicActions & {
  activeId: string | null;          // host post/story id whose song is playing
  muted: boolean;
};

// SPLIT contexts — this provider's value used to be one unmemoized object, so
// every `activeId` flip (EVERY reel/feed swipe onto a song post) re-rendered
// every usePostMusic() consumer app-wide — including the entire Home feed
// sitting under the reels modal. Actions are identity-stable forever; `muted`
// and `activeId` each get their own context so consumers subscribe to exactly
// what they render (most hot paths need actions + muted, never activeId).
const ActionsCtx = createContext<PostMusicActions | null>(null);
const MutedCtx = createContext<boolean>(false);
const ActiveIdCtx = createContext<string | null>(null);

// ── Per-host "is my song active?" subscription (module store) ───────────────
// story-camera (ALWAYS mounted as pager page 0, with a live CameraView) and the
// shop listing preview only need "is MY host the active one?" — subscribing
// them to ActiveIdCtx re-rendered the ENTIRE camera screen on every ambient
// song start/stop/handoff, a heavy hidden cost paid only when song posts
// scrolled by (it even fired underneath the reels modal).
let activeIdNow: string | null = null;
const activeSubs = new Map<string, Set<() => void>>();
function publishActiveId(next: string | null) {
  if (next === activeIdNow) return;
  const prev = activeIdNow;
  activeIdNow = next;
  for (const id of [prev, next]) {
    if (!id) continue;
    const s = activeSubs.get(id);
    if (s) for (const cb of s) cb();
  }
}
// Re-renders the caller ONLY when `activeId === hostId` flips for ITS host.
export function useSongHostActive(hostId: string): boolean {
  const subscribe = useCallback((cb: () => void) => {
    let s = activeSubs.get(hostId);
    if (!s) { s = new Set(); activeSubs.set(hostId, s); }
    s.add(cb);
    return () => {
      const set = activeSubs.get(hostId);
      if (set) { set.delete(cb); if (!set.size) activeSubs.delete(hostId); }
    };
  }, [hostId]);
  return useSyncExternalStore(subscribe, () => activeIdNow === hostId);
}

// ── Per-SONG "is this song playing?" subscription (same pattern, song-keyed) ──
// The shop listing page and a feed shop-ad strip play the SAME preview under
// DIFFERENT hosts — host-keyed state can't tell the listing page "your preview
// is already playing" when the feed ad started it. Keyed by the songId passed
// to playSong (shop previews use the LISTING id), published alongside the host.
let activeSongIdNow: string | null = null;
const songSubs = new Map<string, Set<() => void>>();
function publishActiveSongId(next: string | null) {
  if (next === activeSongIdNow) return;
  const prev = activeSongIdNow;
  activeSongIdNow = next;
  for (const id of [prev, next]) {
    if (!id) continue;
    const s = songSubs.get(id);
    if (s) for (const cb of s) cb();
  }
}
// Re-renders the caller ONLY when `activeSongId === songId` flips for ITS song.
export function useSongIdActive(songId: string | null | undefined): boolean {
  const key = songId ?? '';
  const subscribe = useCallback((cb: () => void) => {
    if (!key) return () => {};
    let s = songSubs.get(key);
    if (!s) { s = new Set(); songSubs.set(key, s); }
    s.add(cb);
    return () => {
      const set = songSubs.get(key);
      if (set) { set.delete(cb); if (!set.size) songSubs.delete(key); }
    };
  }, [key]);
  return useSyncExternalStore(subscribe, () => !!key && activeSongIdNow === key);
}

export function PostMusicProvider({ children }: { children: React.ReactNode }) {
  const { isPlaying: mainPlaying, currentTrack: mainTrack } = useAudio();
  const { suspended } = useMediaSuspend();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);

  // The last playSong() swallowed because the mini-player was busy. If the user
  // CLOSES their track while still on that host (post viewer, feed post, story),
  // the attached song takes over — no confusing silence, and what's audible
  // always matches what's on screen. Cleared whenever the host bows out
  // (stop(hostId)) or ambient is stopped globally, so it can never fire stale.
  const deferredRef = useRef<{ hostId: string; songId: string; mediaUrl: string | null } | null>(null);

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
      // Ambient/attached-post audio must NEVER keep playing outside the app —
      // only the MAIN player (mini-player / music tab) is allowed background
      // playback with the iOS now-playing controls. Stop on true backgrounding
      // ('inactive' is skipped: control-center pulls and the app switcher
      // shouldn't kill the feed's ambient song).
      if (s === 'background') stop();
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

  // ── ONE persistent ambient player for the whole session ────────────────────
  // createAudioPlayer() is a synchronous NATIVE construction — doing it inside
  // playSong (the moment a song card is tapped, or scroll-rest lands on a song
  // post) froze the video playing underneath EVERY time. This is the audio
  // version of the video pools' rule #1 (lib/feedVideoPool): never create OR
  // dispose a player mid-interaction. The player is created once — lazily, or
  // ahead of time by the feed gate via warmSongPlayer() — then every song
  // change is a replace() source swap and stop() is pause-only. The native
  // player is fully released only when the provider unmounts.
  const lastPosRef = useRef(0);
  function ensurePlayer(): AudioPlayer {
    let p = soundRef.current;
    if (p) return p;
    // keepAudioSessionActive: expo-audio's native pause() otherwise DEACTIVATES
    // the app-wide AVAudioSession — and this player pauses exactly when the
    // main player takes over and when the app backgrounds, which killed the
    // main player's (track-player) audio mid-song / on background.
    p = createAudioPlayer(null, { updateInterval: 500, keepAudioSessionActive: true });
    p.loop = true;
    p.muted = mutedRef.current;
    soundRef.current = p;
    // ONE listener for the player's lifetime — which song it accrues toward
    // follows activeSongRef; lastPos resets on every source swap. The loop
    // seam reads as a negative/large jump and is ignored, as is muted or
    // background time.
    statusSubRef.current = p.addListener('playbackStatusUpdate', (st: any) => {
      const sid = activeSongRef.current;
      if (!sid || !st.isLoaded) return;
      const pos = (st.currentTime ?? 0) * 1000;   // expo-audio reports SECONDS
      const delta = pos - lastPosRef.current;
      lastPosRef.current = pos;
      if (delta > 0 && delta < 1500 && !mutedRef.current && appActiveRef.current) accrueAmbient(sid, delta);
    });
    return p;
  }
  function warmSongPlayer() { try { ensurePlayer(); } catch {} }
  function destroyPlayer() {
    statusSubRef.current?.remove(); statusSubRef.current = null;
    const s = soundRef.current;
    soundRef.current = null;
    if (s) { try { s.pause(); } catch {} try { s.remove(); } catch {} }
  }

  function setActiveHost(v: string | null) {
    publishActiveId(v); // per-host subscribers (story-camera, shop) first
    // activeSongRef is always written BEFORE setActiveHost on every path
    // (playSong / same-song transfer / stop), so publishing it here keeps the
    // song-keyed store in lockstep with the host-keyed one.
    publishActiveSongId(v ? activeSongRef.current : null);
    setActiveId(v);
  }

  function stop(hostId?: string) {
    if (hostId && activeIdRef.current !== hostId) {
      // Not the active host — but a host leaving must still withdraw its own
      // DEFERRED claim (its playSong was swallowed while the mini-player
      // played), or closing the bar later could start a song for a post the
      // user already left.
      if (deferredRef.current?.hostId === hostId) deferredRef.current = null;
      return;
    }
    deferredRef.current = null;
    tokenRef.current++; // cancel any in-flight load
    activeIdRef.current = null;
    activeSongRef.current = null;
    setActiveHost(null);
    // Pause-only — the persistent player (and its loaded source) survives, so
    // the next playSong is a cheap replace(), never a create.
    try { soundRef.current?.pause(); } catch {}
  }

  // Resolve (and cache) a song's audio URL without touching playback.
  // IN-FLIGHT DEDUPED: viewability fires prefetchSong repeatedly while a song
  // post is on screen — without the promise cache every event during the RTT
  // window launched a DUPLICATE Supabase query on the JS thread mid-scroll,
  // and playSong fired its own second round trip instead of reusing the
  // prefetch. Now everyone shares one promise per song.
  const inflightUrl = useRef(new Map<string, Promise<string | null>>()).current;
  function resolveSongUrl(songId: string, mediaUrl?: string | null): Promise<string | null> {
    if (mediaUrl) { urlCache.set(songId, mediaUrl); return Promise.resolve(mediaUrl); }
    const hit = urlCache.get(songId);
    if (hit) return Promise.resolve(hit);
    let p = inflightUrl.get(songId);
    if (!p) {
      p = (async () => {
        try {
          const { data } = await supabase.from('posts').select('media_url').eq('id', songId).single();
          const url = (data as any)?.media_url ?? null;
          if (url) urlCache.set(songId, url);
          return url;
        } finally {
          inflightUrl.delete(songId);
        }
      })();
      inflightUrl.set(songId, p);
    }
    return p;
  }
  // Which source URI the persistent player currently holds. Lets playSong skip
  // the replace() when the bytes are already staged, and staging skip itself
  // when it would be redundant. Updated at EVERY replace site so it can never
  // disagree with the native player.
  const stagedUriRef = useRef<string | null>(null);

  function prefetchSong(songId: string, mediaUrl?: string | null) {
    resolveSongUrl(songId, mediaUrl)
      .then((url) => {
        // STAGE THE BYTES, not just the URL. The audible 1–2s gap on landing
        // was never the URL lookup (cached by the time the scroll rests) — it
        // was the native player only STARTING to fetch the audio file at
        // rest+150ms. A paused replace() here begins that download during the
        // approach instead, so the rest-flush's play() is a rate change on a
        // buffered source.
        //
        // Guards, each of which degrades to today's behaviour when it trips:
        //  · player must already EXIST — never create one mid-scroll (the
        //    audio version of the pool rule; the feed gate pre-creates it via
        //    warmSongPlayer, and it exists forever after the first song).
        //  · no ambient song may be ACTIVE — replace() would cut it off. The
        //    playing-song handoff keeps its existing rest-time behaviour.
        //  · not while the user's own track has the mini-player — playSong
        //    would defer in that state anyway, so the bytes would be wasted.
        const p = soundRef.current;
        if (!url || !p) return;
        if (activeSongRef.current || mainPlayingRef.current) return;
        if (stagedUriRef.current === url) return;
        try {
          p.replace({ uri: url }); // paused: loads/buffers, plays nothing
          stagedUriRef.current = url;
        } catch {}
      })
      .catch(() => {});
  }

  async function playSong(hostId: string, songId: string, mediaUrl?: string | null) {
    // Don't fight the user's chosen track in the mini-player — but REMEMBER
    // the request (after stop(), which clears any previous claim): if the user
    // closes their track while still on this host, its song starts (below).
    if (mainPlayingRef.current) {
      stop();
      deferredRef.current = { hostId, songId, mediaUrl: mediaUrl ?? null };
      return;
    }
    if (activeIdRef.current === hostId && activeSongRef.current === songId && soundRef.current) return;

    // Same SONG already playing for a DIFFERENT host (consecutive posts sharing
    // a song — common on a music app): transfer ownership and keep playing.
    // Tearing down + recreating the native player for the identical stream was
    // pure audio-session churn — a UI-thread stall at the exact swipe moment.
    if (activeSongRef.current === songId && soundRef.current) {
      tokenRef.current++; // abort any in-flight load for another song
      activeIdRef.current = hostId;
      setActiveHost(hostId);
      return;
    }

    const token = ++tokenRef.current;
    activeIdRef.current = hostId;
    activeSongRef.current = songId;
    setActiveHost(hostId);

    const url = await resolveSongUrl(songId, mediaUrl);
    if (token !== tokenRef.current) return;
    if (!url) {
      // Unplayable song (deleted post, resolve failure): SILENCE — the
      // previous song must not keep looping under a post it doesn't belong to.
      stop();
      return;
    }

    try {
      // Persistent player: this path never creates, never disposes — replace()
      // is a native source swap, so a song tap over a playing video can't
      // stall the frame anymore.
      const player = ensurePlayer();
      lastPosRef.current = 0;
      if (stagedUriRef.current !== url) {
        player.replace({ uri: url });
        stagedUriRef.current = url;
      }
      // else: prefetchSong already staged these bytes during the approach —
      // play() on the buffered source is the instant start.
      player.muted = mutedRef.current;
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

  // When the main player starts (e.g. the user tapped a song name → it's
  // promoted), stop ambient so the two don't overlap — but capture what was
  // interrupted as the deferred claim first. Without this, the common feed
  // sequence "resting on a song post (ambient audible) → start my own track →
  // later close it" ended in silence: the feed's dedupe still believed the
  // post was claimed and never re-asked. stop() wipes deferredRef, so the
  // capture is written after; a claim that predates a mere pause/resume cycle
  // (no interrupted ambient to capture) is preserved rather than lost.
  useEffect(() => {
    if (!mainPlaying) return;
    const h = activeIdRef.current, s = activeSongRef.current;
    const prior = deferredRef.current;
    stop();
    deferredRef.current = h && s ? { hostId: h, songId: s, mediaUrl: null } : prior;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainPlaying]);

  // The main track went away entirely (× on the bar/chip, or the queue ended —
  // NOT a pause): hand off to the deferred attached song, so a post with a
  // song never sits silent after the user exits their own music while on it.
  const hadMainTrackRef = useRef(false);
  useEffect(() => {
    const has = !!mainTrack;
    if (!has && hadMainTrackRef.current) {
      const d = deferredRef.current;
      if (d) { deferredRef.current = null; playSong(d.hostId, d.songId, d.mediaUrl); }
    }
    hadMainTrackRef.current = has;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainTrack]);

  // Global media suspend (a Cast session, the GIF maker, …): pause the ambient
  // post song so the phone falls silent behind the takeover — casting a video
  // to the TV must not leave its attached song looping on the phone — then
  // resume the SAME song when the suspend lifts. Only touches a song WE paused,
  // so it never revives one the user stopped, and never fights the main player.
  const suspendPausedRef = useRef(false);
  useEffect(() => {
    const p = soundRef.current;
    if (suspended) {
      if (p && activeSongRef.current) { try { p.pause(); } catch {} suspendPausedRef.current = true; }
    } else if (suspendPausedRef.current) {
      suspendPausedRef.current = false;
      if (p && activeSongRef.current && !mainPlayingRef.current) { try { p.play(); } catch {} }
    }
  }, [suspended]);

  // Tidy up on unmount — persist ambient progress first so nothing is lost.
  useEffect(() => () => { saveAmbient(); destroyPlayer(); }, []);

  // Stable forever: the functions close over refs + stable setters only.
  const actions = useMemo(() => ({ toggleMuted, playSong, stop, prefetchSong, warmSongPlayer }), []);

  return (
    <ActionsCtx.Provider value={actions}>
      <MutedCtx.Provider value={muted}>
        <ActiveIdCtx.Provider value={activeId}>
          {children}
        </ActiveIdCtx.Provider>
      </MutedCtx.Provider>
    </ActionsCtx.Provider>
  );
}

// Narrow hooks — use these on hot paths (feeds, reels, viewers):
// actions never change identity; muted changes only on user mute-taps.
export function usePostMusicActions(): PostMusicActions {
  const c = useContext(ActionsCtx);
  if (!c) throw new Error('usePostMusicActions must be used within PostMusicProvider');
  return c;
}
export function usePostMusicMuted(): boolean {
  return useContext(MutedCtx);
}

// Full hook — subscribes to activeId too (re-renders per song-host change);
// only for screens that actually render activeId (story-camera preview, shop).
export function usePostMusic(): PostMusicType {
  const actions = usePostMusicActions();
  const muted = useContext(MutedCtx);
  const activeId = useContext(ActiveIdCtx);
  return useMemo(() => ({ ...actions, muted, activeId }), [actions, muted, activeId]);
}
