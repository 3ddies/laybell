import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import { getDeviceId } from '../lib/deviceId';
import { useAudio } from './AudioContext';
import { useMediaSuspend } from './MediaSuspendContext';
import { getPlaybackPosition, subscribePlayback } from '../lib/playbackClock';
import { isVideoWrap, songPositionFor, type AmbientMix } from '../lib/songMix';

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
//
// A post's SOUND MIX (lib/songMix, 1.0.3). A video post can carry which part of
// its song plays and how loud the song is, and such a song belongs to its video:
// it starts at its part when the video starts, goes back to it each time the
// video loops, and follows the video when it is scrubbed. Videos report where
// they are through lib/playbackClock under their post id — the id hosts pass
// here. A post without a mix plays its song exactly as before: full volume,
// looping on its own, never moved.

const AMBIENT_THRESHOLD_MS = 30_000;            // 30s of genuine listening → 1 stream
const AMBIENT_WINDOW_MS = 24 * 60 * 60 * 1000;  // per-song cap window (matches the rest)
const AMBIENT_KEY = 'ambient_stream_progress_v1';
// A mixed song is moved back into line with its video only past this much drift:
// more than a slow start or a stall costs, less than an audible stretch of the
// wrong bar. After a line-up seek the next check waits this long, so a slow seek
// on a remote file can never turn into a storm of them.
const MIX_DRIFT_SEC = 2.5;
const MIX_SETTLE_MS = 1200;

type PostMusicActions = {
  toggleMuted: () => void;
  // Play `songId`'s audio for host `hostId`. mediaUrl optional (resolved + cached).
  // `mix` is the host post's sound (lib/songMix ambientMixFor). Without one the song
  // plays at full volume and loops on its own, as every song always has.
  playSong: (hostId: string, songId: string, mediaUrl?: string | null, mix?: AmbientMix | null) => void;
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
  const deferredRef = useRef<{ hostId: string; songId: string; mediaUrl: string | null; mix: AmbientMix | null } | null>(null);

  const soundRef = useRef<AudioPlayer | null>(null);
  const statusSubRef = useRef<{ remove: () => void } | null>(null);
  const tokenRef = useRef(0);
  const activeIdRef = useRef<string | null>(null);
  const activeSongRef = useRef<string | null>(null);
  const mutedRef = useRef(false); mutedRef.current = muted;
  const mainPlayingRef = useRef(false); mainPlayingRef.current = mainPlaying;
  // Mirrored for playSong, which is not a render path and so cannot read the
  // state. The [suspended] effect below fires only on TRANSITIONS, so it can
  // never re-pause a song that starts after it ran — playSong has to check for
  // itself. Declared here with the other mirrors rather than beside the effect,
  // because playSong (above it) is the reason both exist.
  const suspendedRef = useRef(false); suspendedRef.current = suspended;
  // True only when WE paused the ambient song for a suspend, so the resume path
  // never revives a song the user stopped and never fights the main player.
  const suspendPausedRef = useRef(false);
  const urlCache = useRef<Map<string, string>>(new Map()).current;

  // ─── a post's sound mix (lib/songMix) ────────────────────────────────────────
  // requestRef         – the latest ask for the active song: which host, which mix.
  //                      A load still in flight applies it when it lands.
  // loadingRef         – the token of the playSong still loading, if any
  // mixRef             – the mix applied to the playing song; null plays it as always
  // clockRef           – the host video's clock subscription, and the last position
  // seekRef            – the line-up seek in flight: one at a time; replace() waits
  // mixSeekDueRef      – a line-up that could not run yet (loading, or a seek busy)
  // playWhenLinedUpRef – a mixed song held until it is at its part (its token)
  const requestRef = useRef<{ hostId: string; mix: AmbientMix | null } | null>(null);
  const loadingRef = useRef<number | null>(null);
  const mixRef = useRef<AmbientMix | null>(null);
  const clockRef = useRef<{ hostId: string; lastSec: number | null; off: () => void } | null>(null);
  const seekRef = useRef<Promise<void> | null>(null);
  const settleUntilRef = useRef(0);
  const mixSeekDueRef = useRef(false);
  const playWhenLinedUpRef = useRef<number | null>(null);

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
      // A mixed song's source is ready: the line-up it was waiting for.
      if (mixSeekDueRef.current) lineUpWithVideo(true);
      // A mixed song does not loop natively (that would restart it from its first
      // second): at its end it goes back to its part and plays on.
      if (st.didJustFinish && mixRef.current?.startSec != null) restartMixedSong();
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
    requestRef.current = null;
    loadingRef.current = null;
    playWhenLinedUpRef.current = null;
    mixRef.current = null;
    mixSeekDueRef.current = false;
    watchVideoClock(null);
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
        //  · no line-up seek in flight — see lineUpWithVideo.
        if (seekRef.current) return;
        try {
          p.replace({ uri: url }); // paused: loads/buffers, plays nothing
          stagedUriRef.current = url;
        } catch {}
      })
      .catch(() => {});
  }

  // ─── a post's sound mix ──────────────────────────────────────────────────────
  // Apply a host's mix to the song playing for it. `startOver`: the host's video is
  // starting, so a mixed song goes to its part now. Otherwise only a changed part
  // moves the song, and a level change never does — which is what lets the video
  // studio ask again on every slider move.
  function applyMix(hostId: string, mix: AmbientMix | null, startOver: boolean) {
    const prev = mixRef.current;
    mixRef.current = mix;
    const p = soundRef.current;
    try { if (p) p.volume = mix ? mix.volume : 1; } catch {}
    if (!mix || mix.startSec == null) {
      watchVideoClock(null);
      mixSeekDueRef.current = false;
      try { if (p) p.loop = true; } catch {}
      startIfWaiting();
      return;
    }
    watchVideoClock(hostId);
    // Not looped natively: that restarts it from its first second rather than its
    // part. restartMixedSong loops it instead.
    try { if (p) p.loop = false; } catch {}
    if (startOver || prev?.startSec !== mix.startSec || prev?.videoStartSec !== mix.videoStartSec) lineUpWithVideo(true);
  }

  // Follow the host video's clock (lib/playbackClock) while its mixed song plays.
  function watchVideoClock(hostId: string | null) {
    const current = clockRef.current;
    if (current && current.hostId === hostId) return;
    current?.off();
    clockRef.current = null;
    if (!hostId) return;
    const entry: { hostId: string; lastSec: number | null; off: () => void } = { hostId, lastSec: null, off: () => {} };
    entry.off = subscribePlayback(hostId, () => {
      if (clockRef.current !== entry) return;
      const sec = getPlaybackPosition(hostId);
      const prevSec = entry.lastSec;
      entry.lastSec = sec;
      // Looped, or scrubbed back: to the part at once. Anything else moves the
      // song only once the two have drifted apart.
      lineUpWithVideo(prevSec != null && isVideoWrap(prevSec, sec));
    });
    clockRef.current = entry;
  }

  // Put a mixed song where its video says it should be: its part, plus however far
  // the video is past its first second (songPositionFor). `force` moves it
  // regardless — the video started, looped or was scrubbed back; otherwise only
  // drift past MIX_DRIFT_SEC does.
  //
  // Only a LOADED source is ever sought, and only one seek at a time. On iOS,
  // seeking an item that is not ready to play raises an exception that takes the
  // app down — and seekTo is asynchronous while replace() is not, so a seek left
  // in flight could land on the NEXT song before it has loaded (playSong and the
  // prefetch staging both wait for it). A line-up that cannot run yet stays due,
  // and the status listener runs it once the source is ready.
  function lineUpWithVideo(force: boolean) {
    const p = soundRef.current;
    const mix = mixRef.current;
    const host = activeIdRef.current;
    if (!p || !host || !mix || mix.startSec == null) return;
    if (seekRef.current) { if (force) mixSeekDueRef.current = true; return; }
    const due = force || mixSeekDueRef.current;
    if (!due && Date.now() < settleUntilRef.current) return;
    let loaded = false;
    try { loaded = p.isLoaded; } catch {}
    if (!loaded) { mixSeekDueRef.current = true; return; }
    let duration = 0;
    try { duration = p.duration || 0; } catch {}
    const clock = clockRef.current;
    const videoSec = clock && clock.hostId === host && clock.lastSec != null ? clock.lastSec : getPlaybackPosition(host);
    const target = songPositionFor(mix.startSec, videoSec, mix.videoStartSec, duration);
    if (!due) {
      let at = target;
      try { at = p.currentTime; } catch {}
      if (Math.abs(at - target) < MIX_DRIFT_SEC) return;
    }
    mixSeekDueRef.current = false;
    let seek: Promise<void>;
    try { seek = p.seekTo(target); } catch { startIfWaiting(); return; }
    const settled: Promise<void> = seek.catch(() => {}).then(() => {
      if (seekRef.current === settled) seekRef.current = null;
      settleUntilRef.current = Date.now() + MIX_SETTLE_MS;
      if (mixSeekDueRef.current) lineUpWithVideo(true);
      if (!seekRef.current && !mixSeekDueRef.current) startIfWaiting();
    });
    seekRef.current = settled;
  }

  // A mixed song held for its line-up starts now: the seek landed, or there is
  // nothing left to line up. Stale if a stop() or another song came in between
  // (the token), and it honours a suspend and the main player as playSong does.
  function startIfWaiting() {
    const waiting = playWhenLinedUpRef.current;
    if (waiting == null) return;
    playWhenLinedUpRef.current = null;
    const p = soundRef.current;
    if (!p || waiting !== tokenRef.current || !activeSongRef.current) return;
    if (suspendedRef.current) { suspendPausedRef.current = true; return; }
    if (mainPlayingRef.current) return;
    try { p.play(); } catch {}
  }

  // A mixed song reached its end before its video looped: back to its part, and on.
  function restartMixedSong() {
    if (!soundRef.current || !activeSongRef.current) return;
    playWhenLinedUpRef.current = tokenRef.current;
    lineUpWithVideo(true);
    if (!seekRef.current && !mixSeekDueRef.current) startIfWaiting();
  }

  async function playSong(hostId: string, songId: string, mediaUrl?: string | null, mix?: AmbientMix | null) {
    const nextMix = mix ?? null;
    // Don't fight the user's chosen track in the mini-player — but REMEMBER
    // the request (after stop(), which clears any previous claim): if the user
    // closes their track while still on this host, its song starts (below).
    if (mainPlayingRef.current) {
      stop();
      deferredRef.current = { hostId, songId, mediaUrl: mediaUrl ?? null, mix: nextMix };
      return;
    }
    // This host's song already. Asked again, it may carry a new mix — the video
    // studio asks on every slider move — so the level and part change in place and
    // the song never restarts for it.
    if (activeIdRef.current === hostId && activeSongRef.current === songId && soundRef.current) {
      requestRef.current = { hostId, mix: nextMix };
      if (loadingRef.current !== tokenRef.current) applyMix(hostId, nextMix, false);
      return;
    }

    // Same SONG already playing for a DIFFERENT host (consecutive posts sharing
    // a song — common on a music app): transfer ownership and keep playing.
    // Tearing down + recreating the native player for the identical stream was
    // pure audio-session churn — a UI-thread stall at the exact swipe moment.
    // The new post still gets its own part and level: its video is just starting.
    if (activeSongRef.current === songId && soundRef.current) {
      activeIdRef.current = hostId;
      setActiveHost(hostId);
      requestRef.current = { hostId, mix: nextMix };
      // Still loading for the post before: that load carries on and applies this
      // request when it lands. This path used to bump the token, which aborted
      // it — and the only load that can be in flight here is this same song's
      // (activeSongRef is set before playSong awaits), so the new post was left
      // silent.
      if (loadingRef.current !== tokenRef.current) applyMix(hostId, nextMix, true);
      return;
    }

    const token = ++tokenRef.current;
    activeIdRef.current = hostId;
    activeSongRef.current = songId;
    requestRef.current = { hostId, mix: nextMix };
    loadingRef.current = token;
    setActiveHost(hostId);
    // The song before stops following its video while this one loads, so nothing
    // can start a new seek on it that is still in flight when the source changes.
    mixRef.current = null;
    mixSeekDueRef.current = false;
    playWhenLinedUpRef.current = null;
    watchVideoClock(null);

    let url: string | null = null;
    try { url = await resolveSongUrl(songId, mediaUrl); } catch {}
    if (token !== tokenRef.current) return;
    if (!url) {
      // Unplayable song (deleted post, resolve failure): SILENCE — the
      // previous song must not keep looping under a post it doesn't belong to.
      stop();
      return;
    }
    // Every line-up seek still in flight lands before the source changes — a
    // loop, because a seek settling can start one it had queued.
    while (seekRef.current) {
      await seekRef.current;
      if (token !== tokenRef.current) return;
    }

    try {
      // No longer loading: from here a request for this song applies directly.
      loadingRef.current = null;
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
      // The latest request for this song — a post it was handed to while loading
      // included: its level, loop and part. A part waits for the source to load.
      const req = requestRef.current ?? { hostId, mix: nextMix };
      applyMix(req.hostId, req.mix, true);

      // DO NOT START UNDER A SUSPEND. A suspend is a takeover — a Cast or
      // AirPlay session, the GIF maker — and during a cast the feed keeps
      // scrolling, so this line is genuinely reached while suspended. The
      // [suspended] effect cannot save it: that fires on transitions, and this
      // start happens after it already ran.
      //
      // app/tv/airplay.tsx says suspend() "pauses feed videos + the ambient song
      // player". Videos honour it (AppVideo/FeedVideo/ReelVideo each read
      // `suspended` on their own render path); the ambient player only honoured
      // it for a song already playing when the suspend began. Scroll onto a song
      // post mid-cast and it played out of the phone, over the cast.
      //
      // Marked as suspend-paused rather than dropped, so the song is staged and
      // starts when the takeover ends — the same outcome as one paused BY the
      // suspend, which is what it would have been a moment earlier.
      if (suspendedRef.current) { suspendPausedRef.current = true; return; }
      // A song being lined up with its part starts once it is there — never with a
      // moment of wherever the source happened to be.
      if (mixSeekDueRef.current || seekRef.current) { playWhenLinedUpRef.current = token; return; }
      player.play();
    } catch {}
  }

  function toggleMuted() {
    // Computed from the ref and applied OUTSIDE the updater. A state updater has
    // to be pure — React may call it more than once for a single update (it does
    // in StrictMode), and each extra call flipped the native player again, so the
    // mute button and the audio could end up disagreeing.
    //
    // Writing mutedRef here also closes a real accounting hole: it used to be
    // assigned during render, one render behind the native mute, and the
    // accrual listener reads it on a 500ms tick. Muting could therefore credit
    // up to a tick of MUTED listening toward the 30s that earns a stream — which
    // the file's own contract says never counts.
    const next = !mutedRef.current;
    mutedRef.current = next;
    try { if (soundRef.current) soundRef.current.muted = next; } catch {}
    setMuted(next);
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
    const req = requestRef.current;
    const prior = deferredRef.current;
    stop();
    deferredRef.current = h && s ? { hostId: h, songId: s, mediaUrl: null, mix: req && req.hostId === h ? req.mix : null } : prior;
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
      if (d) { deferredRef.current = null; playSong(d.hostId, d.songId, d.mediaUrl, d.mix); }
    }
    hadMainTrackRef.current = has;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainTrack]);

  // Global media suspend (a Cast session, the GIF maker, …): pause the ambient
  // post song so the phone falls silent behind the takeover — casting a video
  // to the TV must not leave its attached song looping on the phone — then
  // resume the SAME song when the suspend lifts. Only touches a song WE paused,
  // so it never revives one the user stopped, and never fights the main player.
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
  useEffect(() => () => { saveAmbient(); watchVideoClock(null); destroyPlayer(); }, []);

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
