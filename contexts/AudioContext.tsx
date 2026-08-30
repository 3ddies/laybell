import React, { createContext, useContext, useState, useRef, useEffect, useCallback, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import TrackPlayer, { Event as TPEvent, State as TPState } from 'react-native-track-player';
import { ensurePlayerSetup, setRemoteHandlers, setNowPlayingLiked } from '../lib/trackPlayerService';
import { fetchSongLiked, setSongLike, publishSongLike, subscribeSongLike } from '../lib/songLike';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import { getDeviceId } from '../lib/deviceId';
import { playThresholds } from '../lib/playThresholds';
import { bumpBadge } from '../lib/badges';
import { resolveLocalUri, markInUse, clearInUse, autoCache } from '../lib/offline';
import { recordListen } from '../lib/listenHistory';
import { recordStream as recordStreamDurable } from '../lib/streamOutbox';
import { meterPlayback, flushMeter } from '../lib/listenMeter';
import { handoffPositionMs } from '../lib/postSong';
import {
  pickAudioAd, recordAdImpression, recordAdComplete, recordAdSkip,
  firstAudioGateMs, nextAudioGateMs, adSkipAfterMs,
  type AdViewer, type AudioAd,
} from '../lib/ads';
import { buildAffinityProfile, EMPTY_PROFILE, scorePost } from '../lib/feedScorer';
import { tg } from '../lib/i18n';

// Per-post listen progress persists for a rolling 24h window (matches the
// server's per-user/post stream cap) so force-quitting can't reset it.
const STREAM_PROGRESS_KEY = 'stream_progress_v1';
const STREAM_WINDOW_MS = 24 * 60 * 60 * 1000;
// Anti-farm cap for the music-streaming badge: a single song contributes at most
// 10 minutes of listen time toward badge progress, no matter how long it's looped.
// Once a song hits the cap it stops counting until a DIFFERENT song is streamed.
const BADGE_SONG_CAP_MS = 10 * 60 * 1000;

// expo-audio AudioMode (migrated from the old expo-av keys): play through the iOS
// silent switch, keep playing in the background, and duck other apps' audio.
const AUDIO_MODE = {
  playsInSilentMode: true,
  shouldPlayInBackground: true,
  interruptionMode: 'duckOthers' as const,
  shouldRouteThroughEarpiece: false,
  allowsRecording: false,
};

export type Track = {
  id: string;
  uri: string;
  caption: string;
  artist: string;
  cover?: string | null;
};

// Audio-ad takeover state surfaced to the player UIs (NowPlaying / MiniPlayer)
// while an audio ad is interrupting a playlist. Carries the campaign/creative
// ids so the UI's CTA can record a click via lib/ads.
export type AudioAdState = {
  campaignId: string;
  creativeId: string;
  ownerId: string;
  advertiserName: string;
  headline: string;
  ctaLabel: string;
  ctaUrl: string | null;
  cover?: string | null;
  viewerId: string | null;
  elapsedMs: number;
  durationMs: number;
  canSkip: boolean;
  // Objective destination fields — adDestination(adState) reads these to build
  // the CTA. They were dropped here before, which silently killed the CTA on
  // every awareness/engagement audio ad (only traffic's ctaUrl survived).
  objective?: string | null;
  targetProfileIds?: string[] | null;
  // Simple shop ads: the featured listing (CTA → product page; the UI also
  // titles the break like a song — product title on the title line).
  listingId?: string | null;
  // Resolved skip gate for THIS ad (ms; Infinity = unskippable) so the
  // countdown labels agree with the actual unlock instead of assuming 10s.
  skipAfterMs: number;
};

// Supplies MORE relevant tracks when the queue runs low, excluding ids already
// queued — lets a home-feed queue keep "next" working forever (see index.tsx).
export type QueueLoader = (excludeIds: Set<string>) => Promise<Track[]>;

type AudioContextType = {
  currentTrack: Track | null;
  isPlaying: boolean;
  isBuffering: boolean;
  play: (track: Track) => Promise<void>;
  /**
   * play(), but continuing from `atMs` instead of 0:00 — the music-video
   * handoff. `sourceMs` is the HOST video's duration, and is the evidence: the
   * position is honoured only where the two lengths agree, since nothing
   * guarantees a post called a music video is one. See handoffPositionMs. Any
   * doubt and it starts from the top.
   */
  playFrom: (track: Track, atMs: number, sourceMs: number) => Promise<void>;
  playQueue: (tracks: Track[], startIndex?: number, loadMore?: QueueLoader) => Promise<void>;
  // Now Playing reports comment activity so a song ending at the end of the queue
  // doesn't tear the sheet away while the user is still engaged with the comments.
  setCommentComposing: (composing: boolean) => void; // focused / draft / reply
  noteCommentEngagement: () => void;                  // any comment touch (armed only ≥80%)
  clearCommentEngagement: () => void;                 // scrolled back to the top — drop the hold
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
  hasMore: boolean; // more relevant tracks can be pulled in → "next" stays enabled
  videoMuted: boolean;
  toggleVideoMuted: () => void;
  // Audio ads (playlist breaks). adState is non-null only while an ad is playing.
  adState: AudioAdState | null;
  skipAudioAd: () => void;
};

const AudioContext = createContext<AudioContextType | null>(null);

// Playback position is deliberately NOT React state on the provider: a 250ms
// setState there re-rendered EVERY useAudio() consumer (Home feed, Music page,
// the whole Now Playing tree) four times a second for the entire duration of a
// song — which is what made the Now Playing swipe-down stutter (the drag is
// JS-driven and was fighting those re-renders). Position flows through this
// subscription instead: only components that call useAudioPosition() re-render
// on ticks (the scrubbers/time labels), everything else stays still.
type PositionListener = (positionMs: number, durationMs: number) => void;
type SubscribePosition = (fn: PositionListener) => () => void;
const AudioPositionContext = createContext<SubscribePosition | null>(null);

export function useAudioPosition(): { positionMs: number; durationMs: number } {
  const subscribe = useContext(AudioPositionContext);
  if (!subscribe) throw new Error('useAudioPosition must be used within AudioProvider');
  const [state, setState] = useState({ positionMs: 0, durationMs: 0 });
  useEffect(
    () => subscribe((positionMs, durationMs) => setState({ positionMs, durationMs })),
    [subscribe],
  );
  return state;
}

// ── Now-playing subscription store (module) ─────────────────────────────────
// Grids and track rails only need "which track id is playing, and is it playing"
// to badge the active item. Subscribing them to the whole AudioContext re-rendered
// them on every isBuffering / adState / queueIndex change (e.g. the Explore grid
// re-mapped all its cells on an ad boundary). This mirrors the position-subscription
// trick above (and PostMusicContext's useSongHostActive): consumers subscribe to
// ONLY this slice via useSyncExternalStore. Purely additive — the AudioContext
// value below is untouched, so every existing useAudio() consumer is unaffected.
let nowPlayingSnap: { id: string | null; playing: boolean } = { id: null, playing: false };
const nowPlayingSubs = new Set<() => void>();
function publishNowPlaying(id: string | null, playing: boolean) {
  if (id === nowPlayingSnap.id && playing === nowPlayingSnap.playing) return;
  nowPlayingSnap = { id, playing };
  for (const cb of nowPlayingSubs) cb();
}
// A stable wrapper over the live play(): lets a consumer start playback without
// subscribing to the provider. `latestPlay` is refreshed each commit (below).
let latestPlay: ((track: Track) => Promise<void>) | null = null;
const stableNowPlay = (track: Track): Promise<void> => (latestPlay ? latestPlay(track) : Promise.resolve());

// Re-renders the caller ONLY when the playing track id or isPlaying flips — never
// on buffering/ad/queue churn. Drop-in for the { currentTrack, isPlaying, play }
// slice of useAudio() on hot list surfaces.
export function useNowPlaying(): { id: string | null; playing: boolean; play: (track: Track) => Promise<void> } {
  const snap = useSyncExternalStore(
    (cb) => { nowPlayingSubs.add(cb); return () => { nowPlayingSubs.delete(cb); }; },
    () => nowPlayingSnap,
  );
  return { id: snap.id, playing: snap.playing, play: stableNowPlay };
}

// ── Stable control accessors (module) ───────────────────────────────────────
// Screens that only DRIVE audio — never render its state — were paying a full
// useAudio() subscription just to obtain a function. post.tsx pulled `stop`
// alone and re-rendered on every buffering / ad / queue tick; worse, because
// `stop`'s identity changed on every provider render, its `[step, stop]` effect
// re-ran (and re-called stop) each of those times. These wrappers keep ONE
// identity for the app's lifetime and call through to the live implementations,
// refreshed on each commit below — same trick as stableNowPlay above.
let latestPlayQueue: AudioContextType['playQueue'] | null = null;
let latestStop: AudioContextType['stop'] | null = null;
let latestExpand: AudioContextType['expand'] | null = null;
let latestToggleVideoMuted: AudioContextType['toggleVideoMuted'] | null = null;

const AUDIO_CONTROLS = {
  play: stableNowPlay,
  playQueue: (tracks: Track[], startIndex?: number, loadMore?: QueueLoader) =>
    (latestPlayQueue ? latestPlayQueue(tracks, startIndex, loadMore) : Promise.resolve()),
  stop: () => (latestStop ? latestStop() : Promise.resolve()),
  expand: () => { latestExpand?.(); },
  toggleVideoMuted: () => { latestToggleVideoMuted?.(); },
};

// Controls with NO subscription at all: a consumer that only starts/stops
// playback never re-renders on audio state. Pair with useNowPlaying() when the
// caller ALSO needs to badge the active track.
export function useAudioControls() {
  return AUDIO_CONTROLS;
}

// ── videoMuted subscription store (module) ──────────────────────────────────
// The feed needs this single boolean to render its mute glyphs. Reading it off
// the context meant re-rendering the whole feed on every unrelated audio change.
let videoMutedSnap = false;
const videoMutedSubs = new Set<() => void>();
function publishVideoMuted(muted: boolean) {
  if (muted === videoMutedSnap) return;
  videoMutedSnap = muted;
  for (const cb of videoMutedSubs) cb();
}
export function useVideoMuted(): boolean {
  return useSyncExternalStore(
    (cb) => { videoMutedSubs.add(cb); return () => { videoMutedSubs.delete(cb); }; },
    () => videoMutedSnap,
  );
}

export function AudioProvider({ children }: { children: React.ReactNode }) {
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const expand = () => setExpanded(true);
  // Manually leaving the full player for the mini player is the "safe to autoclose"
  // signal — drop the near-end keep-open hold and finish any deferred song-end.
  const collapse = () => {
    setExpanded(false);
    engagedNearEndRef.current = false;
    maybeRunDeferredFinish();
  };
  // Feed video audio. ON at app open; auto-muted once a song plays (no overlap).
  const [videoMuted, setVideoMuted] = useState(false);
  // Main-player engine = react-native-track-player. Its queue always holds
  // exactly ONE track (this context owns queue/advance logic); RNTP owns the
  // audio + the iOS lock-screen / Control Center now-playing card, whose
  // controls route back into this context via lib/trackPlayerService — so the
  // lock screen and the in-app buttons are the SAME controls. expo-audio
  // remains the engine for audio ADS only (adSoundRef below); ads and ambient
  // post music never touch the lock screen.
  const mainLoadedRef = useRef(false); // a track is loaded in the RNTP queue
  // Ad status-listener subscription, removed synchronously on ad teardown (the
  // ad plays on its own expo-audio sound). The MUSIC engine's listeners are
  // GLOBAL — attached once at mount (see the engine-listeners effect below) —
  // because the RNTP queue now advances natively.
  const adStatusSubRef = useRef<{ remove: () => void } | null>(null);
  // Forward-delta accumulator for the ACTIVE track's accounting (reset on
  // every track change — the old per-play closure equivalent).
  const lastPosMsRef = useRef(0);
  // Buffering-UI debounce (see the engine state listener).
  const bufferingDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // While a queue start is IN FLIGHT (add → skip startIndex), the engine
  // momentarily reports track 0 as active before the skip lands — mirroring
  // that flashed the WRONG song on the mini-player for a frame. Until the
  // intended start index arrives, track-change events are ignored.
  const pendingStartIndexRef = useRef<number | null>(null);
  const queueRef = useRef<Track[]>([]);
  const queueIndexRef = useRef(0);
  const queueLoaderRef = useRef<QueueLoader | null>(null);
  // The in-flight appendFromLoader, so concurrent callers JOIN it instead of being
  // told the loader is dry (which used to close the player mid-queue).
  const inflightAppendRef = useRef<Promise<boolean> | null>(null);
  const playTokenRef = useRef(0); // guards against overlapping plays (rapid next/prev)
  const holdForCommentRef = useRef(false); // user is composing a comment in Now Playing
  const engagedNearEndRef = useRef(false); // user touched the comments past 80% → keep the player open
  const pendingFinishRef = useRef(false);   // track finished; advance/close deferred until the user's done
  const progressRef = useRef(0);            // playback fraction (0–1), gates the 80% engagement check
  const positionRef = useRef(0);            // live position (ms), for the "previous" 3s restart rule
  const durationRef = useRef(0);            // live duration (ms), mirror for non-render logic

  // Position subscription (see useAudioPosition above): ticks bypass React
  // state so the provider — and every useAudio() consumer — doesn't re-render
  // four times a second while a song plays.
  const positionListeners = useRef(new Set<PositionListener>()).current;
  const emitPosition = (positionMs: number, durationMs: number) => {
    positionRef.current = positionMs;
    durationRef.current = durationMs;
    positionListeners.forEach((fn) => { try { fn(positionMs, durationMs); } catch {} });
  };
  const subscribePosition = useRef<SubscribePosition>((fn) => {
    positionListeners.add(fn);
    fn(positionRef.current, durationRef.current); // push current values on mount
    return () => { positionListeners.delete(fn); };
  }).current;
  const [queueIndex, setQueueIndex] = useState(0);
  const [queueLength, setQueueLength] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  // Per-post stream accounting, persisted for a rolling 24h window (keyed by post id):
  //   listenMs        – cumulative genuine forward listen time (across replays)
  //   streamsAwarded  – streams already credited via listening (0, 1, or 2)
  //   windowStart     – epoch ms the current 24h window began for this post
  const listenMsRef = useRef<Record<string, number>>({});
  const streamsAwardedRef = useRef<Record<string, number>>({});
  const windowStartRef = useRef<Record<string, number>>({});
  const uidRef = useRef<string | null>(null);
  const deviceIdRef = useRef<string | null>(null); // per-install id for the device cap
  // The post id of the sound currently loaded — used to release the offline
  // in-use lock (so removing/evicting an offline file never yanks it out from
  // under a live player) when we tear it down or switch tracks.
  const loadedIdRef = useRef<string | null>(null);
  // A one-shot "start this track HERE, not at 0:00", used by the music-video
  // handoff: tapping the artwork over a video continues the song from where the
  // video had reached, so the listener moves onto the real player mid-track
  // instead of hearing the song restart under them.
  //
  // Applied from the progress handler rather than straight after load, because
  // that is the first tick carrying the song's DURATION — and the duration is
  // what handoffPositionMs needs to decide whether the two timelines correspond
  // at all. Paired with the track id so a seek cannot land on whatever happens
  // to be playing by the time it resolves.
  const pendingSeekRef = useRef<{ atMs: number; sourceMs: number; id: string } | null>(null);
  const clearPendingSeek = () => { pendingSeekRef.current = null; };
  // Genuine forward listen ms accrued toward the daily "music streaming" badge —
  // a SEPARATE accumulator from the per-post stream credit (listenMsRef), so it
  // sums across posts and isn't tied to any 24h per-post window. Flushed as whole
  // seconds via record_badge_activity (keeping the sub-second remainder → no drift).
  const badgeMsRef = useRef(0);
  // Per-song badge accounting. Only OTHER creators' songs count toward the badge
  // (badgeEligibleRef) so a user can't farm it by looping their own track, and each
  // song is capped at BADGE_SONG_CAP_MS (badgeSongMsRef, keyed by badgeSongIdRef so
  // loops/replays of the same song share one budget; switching songs resets it).
  const badgeSongIdRef = useRef<string | null>(null);
  const badgeSongMsRef = useRef(0);
  const badgeEligibleRef = useRef(false);

  // ── Audio-ad scheduler ──────────────────────────────────────────────────────
  // The ad clock runs for the WHOLE APP SESSION and counts every genuine main-
  // player listen ms — across songs, stops and re-picks (30s of song A + 30s of
  // song B = 1 min accrued). Casual reel/post ambient audio never touches this
  // context, so it never accrues; a post song only counts once it's promoted to
  // the main player (the "actually streams it" rule). First ad due at 1 min per
  // launch, then every 3 min 30 s. A due break fires at the NEXT song boundary
  // (finish, skip, or picking a different song). The ad plays on a SEPARATE
  // sound so the music's stream/badge accounting is never touched; the music is
  // paused (not unloaded) and resumes at the same spot when the ad ends/skips.
  const [adState, setAdState] = useState<AudioAdState | null>(null);
  const adListenMsRef = useRef(0);
  // First break lands later for premium (×2) — firstAudioGateMs applies the
  // spacing multiplier; subsequent gates come from nextAudioGateMs (also scaled).
  const adNextThresholdRef = useRef(firstAudioGateMs());
  const adSoundRef = useRef<AudioPlayer | null>(null);
  const adPlayingRef = useRef(false);
  // Throttle + last-known progress for the ad's iOS lock-screen / Control Center
  // card (updated ~1×/s from the ad status listener; also used to repaint the
  // card if the app is foregrounded mid-ad).
  const adCardSecRef = useRef(-1);
  const adCardPosRef = useRef(0);
  const adCardDurRef = useRef(0);
  const adMetaRef = useRef<AudioAd | null>(null);
  const adViewerRef = useRef<AdViewer | null>(null);
  // An ad break came due (a listening threshold was crossed) but ads NEVER
  // interrupt a song mid-play — instead we set this flag and play the ad once
  // the current song finishes (handled in the track-finished path). Stays set
  // across track changes until the ad actually plays.
  const adDueRef = useRef(false);
  // Ad load watchdog: expo-audio reports load failures via status (it doesn't throw
  // like expo-av's createAsync), so if an ad never starts we resume the music after a
  // timeout instead of hanging the player on a stuck ad.
  const adProgressedRef = useRef(false);
  const adWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One-shot guard: the canSkip unlock is the only per-ad setAdState after start
  // (elapsed/duration ticks flow through the position channel instead).
  const adCanSkipFiredRef = useRef(false);

  // Release an abandoned expo-audio player safely: pause now (sync — stops audio
  // immediately, no overlap) and defer remove() to the next tick, so we never call
  // remove() from inside that player's own 'playbackStatusUpdate' callback (the
  // didJustFinish → advance path runs there).
  function releaseSound(p: AudioPlayer | null) {
    if (!p) return;
    try { p.pause(); } catch {}
    setTimeout(() => { try { p.remove(); } catch {} }, 0);
  }

  // Resolve the viewer (demographics + taste) for ad targeting when a playlist
  // starts. Cached affinity makes this cheap; failures fall back to untargeted.
  async function armAdViewer() {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { adViewerRef.current = { id: null, profile: null, affinity: EMPTY_PROFILE }; return; }
      const [{ data: prof }, affinity] = await Promise.all([
        supabase.from('profiles').select('age, gender, latitude, longitude').eq('id', user.id).single(),
        buildAffinityProfile(user.id),
      ]);
      adViewerRef.current = { id: user.id, profile: (prof as any) ?? null, affinity };
    } catch {
      adViewerRef.current = { id: uidRef.current, profile: null, affinity: EMPTY_PROFILE };
    }
  }

  // A listening threshold was crossed → interrupt with one audio ad (if any
  // inventory matches). Pauses the music in place and plays the ad creative on a
  // separate sound with its own status handler.
  async function fireAudioAd() {
    if (adPlayingRef.current) return;
    adPlayingRef.current = true;
    const viewer = adViewerRef.current ?? { id: uidRef.current, profile: null, affinity: EMPTY_PROFILE };
    let ad: AudioAd | null = null;
    try { ad = await pickAudioAd(viewer); } catch {}
    // stop() or a fresh play() tore the ad state down while we were picking —
    // never resurrect a break over the NEW playback state.
    if (!adPlayingRef.current) return;
    if (!ad) {
      // No matching inventory — push the next break out (randomized 3-5 min).
      adPlayingRef.current = false;
      adNextThresholdRef.current = adListenMsRef.current + nextAudioGateMs();
      // If this break was scheduled BETWEEN songs (the track already finished and
      // is waiting on the ad), there's nothing to resume — proceed to the next
      // track. If it was an ad-first song move (the fresh track is loaded but
      // deliberately unstarted), start it now. Otherwise music is mid-play.
      if (pendingFinishRef.current) maybeRunDeferredFinish();
      else if (mainLoadedRef.current) {
        // Boundary ads only ever pause a song at ~0:00 — restart it cleanly.
        TrackPlayer.seekTo(0).then(() => TrackPlayer.play()).catch(() => {});
        setIsPlaying(true);
      }
      return;
    }
    adMetaRef.current = ad;
    TrackPlayer.pause().catch(() => {});
    setIsPlaying(false);
    flushBadgeMs();
    try {
      adProgressedRef.current = false;
      // keepAudioSessionActive: the ad player's pause/finish must never
      // deactivate the shared AVAudioSession — the MUSIC (track-player)
      // resumes on that same session right after the ad.
      const player = createAudioPlayer({ uri: ad.uri }, { updateInterval: 250, keepAudioSessionActive: true });
      adSoundRef.current = player;
      setAdState({
        campaignId: ad.campaignId, creativeId: ad.creativeId, ownerId: ad.ownerId,
        advertiserName: ad.advertiserName, headline: ad.headline,
        ctaLabel: ad.ctaLabel, ctaUrl: ad.ctaUrl, cover: ad.cover ?? null,
        viewerId: uidRef.current,
        elapsedMs: 0, durationMs: 0, canSkip: false,
        objective: ad.objective ?? null,
        targetProfileIds: ad.targetProfileIds ?? null,
        listingId: ad.listingId ?? null,
        skipAfterMs: adSkipAfterMs('audio', ad.skipMode),
      });
      recordAdImpression(ad, 'audio', uidRef.current);
      adCanSkipFiredRef.current = false;
      emitPosition(0, 0); // bars start at zero, not the paused song's position
      // Swap the iOS lock-screen card over to the ad (track-player is paused, so
      // it won't move the card itself — see pushAdNowPlaying).
      adCardSecRef.current = -1;
      adCardPosRef.current = 0;
      adCardDurRef.current = (ad.durationSeconds ?? 0) * 1000;
      pushAdNowPlaying(ad, 0, adCardDurRef.current);
      adStatusSubRef.current = player.addListener('playbackStatusUpdate', (st: any) => {
        if (!st.isLoaded) return;
        const pos = (st.currentTime ?? 0) * 1000;   // expo-audio reports SECONDS
        const dur = (st.duration ?? 0) * 1000;
        if (pos > 0) adProgressedRef.current = true;
        // Ticks flow through the position channel (the music player is paused
        // during an ad, so there's no conflict) — only the ad bars re-render.
        // Per-tick setAdState here re-rendered EVERY useAudio() consumer
        // app-wide 4×/s for the ad's whole duration ("split-second lag
        // globally whenever an ad plays").
        emitPosition(pos, dur);
        // Advance the lock-screen card's scrubber ~1×/s (cheap native call; the
        // audio is on expo-audio, so track-player won't move the card on its own).
        adCardPosRef.current = pos;
        adCardDurRef.current = dur;
        const adSec = Math.floor(pos / 1000);
        if (adSec !== adCardSecRef.current) { adCardSecRef.current = adSec; pushAdNowPlaying(ad, pos, dur); }
        // adState changes only on the DISCRETE fact: the one-time skip unlock.
        // Threshold now honors the advertiser's skip mode — 'unskippable' → never
        // (Infinity, plays fully), 'skip15' → 15s, legacy/none → 10s default.
        if (!adCanSkipFiredRef.current && pos >= adSkipAfterMs('audio', ad.skipMode)) {
          adCanSkipFiredRef.current = true;
          setAdState((prev) => (prev ? { ...prev, canSkip: true } : prev));
        }
        if (st.didJustFinish) finishAudioAd(false);
      });
      player.play();
      // If the ad never starts (load error — no throw in expo-audio), resume music.
      adWatchdogRef.current = setTimeout(() => {
        if (!adProgressedRef.current) finishAudioAd(false, true);
      }, 10000);
    } catch {
      // Couldn't even create the ad player — just resume the music and reschedule.
      finishAudioAd(false, true);
    }
  }

  // End the current audio ad: log complete/skip, unload it, reschedule the next
  // break, and resume the music exactly where it was paused.
  async function finishAudioAd(skipped: boolean, failed = false) {
    const ad = adMetaRef.current;
    if (ad && !failed) {
      if (skipped) recordAdSkip(ad, 'audio', uidRef.current);
      else recordAdComplete(ad, 'audio', uidRef.current);
    }
    adMetaRef.current = null;
    if (adWatchdogRef.current) { clearTimeout(adWatchdogRef.current); adWatchdogRef.current = null; }
    adStatusSubRef.current?.remove(); adStatusSubRef.current = null;
    releaseSound(adSoundRef.current);
    adSoundRef.current = null;
    setAdState(null);
    adPlayingRef.current = false;
    // Next break randomized 3-5 min out (first-ever gate stays 1 min).
    adNextThresholdRef.current = adListenMsRef.current + nextAudioGateMs();
    if (pendingFinishRef.current) {
      // The track ended WHILE the ad played (handleTrackFinished deferred it) —
      // advance/close now instead of resuming a finished track.
      maybeRunDeferredFinish();
    } else if (mainLoadedRef.current) {
      // Ads only ever pause a song at its boundary (~0:00) — restart it from
      // the top ("every fireAudioAd outcome starts it from 0:00").
      TrackPlayer.seekTo(0).then(() => TrackPlayer.play()).catch(() => {});
      setIsPlaying(true);
      // Hand the position channel back to the music player (the first progress
      // tick fills in the real duration).
      emitPosition(0, 0);
      // Repaint the card as the SONG — we overwrote its metadata with the ad,
      // and resuming the same paused track won't necessarily restore it.
      pushCurrentTrackNowPlaying();
    }
  }

  function skipAudioAd() { finishAudioAd(true); }

  // Paint the iOS lock-screen / Control Center card with the CURRENTLY playing
  // audio ad. Audio ads run on a separate expo-audio player (track-player is
  // paused during a break), so without this the card sits frozen on the paused
  // song while the ad plays — especially jarring for someone streaming in the
  // background. track-player stays the card's owner; we just overwrite its
  // now-playing info with the ad's title / advertiser / cover and push a live
  // elapsedTime so the scrubber advances in step with the ad.
  function pushAdNowPlaying(ad: AudioAd, elapsedMs: number, durMs: number) {
    const sponsored = tg('ad.sponsored');
    TrackPlayer.updateNowPlayingMetadata({
      title: (ad.headline && ad.headline.trim()) || ad.advertiserName || sponsored,
      artist: ad.advertiserName ? `${sponsored} · ${ad.advertiserName}` : sponsored,
      artwork: ad.cover ?? ad.avatarUrl ?? undefined,
      duration: durMs > 0 ? durMs / 1000 : undefined,
      elapsedTime: Math.max(0, elapsedMs / 1000),
    }).catch(() => {});
  }

  // Restore the card to the current music track after an ad ends — resuming the
  // same paused song doesn't necessarily repaint the metadata we overwrote.
  function pushCurrentTrackNowPlaying() {
    const t = queueRef.current[queueIndexRef.current];
    if (!t) return;
    TrackPlayer.updateNowPlayingMetadata({
      title: t.caption || t.artist || 'Laybell',
      artist: t.artist || '',
      artwork: t.cover || undefined,
    }).catch(() => {});
  }

  // Configure the audio session once up front so the first tap plays immediately
  // (a cold session previously made the first createAsync fail to start).
  useEffect(() => { setAudioModeAsync(AUDIO_MODE).catch(() => {}); }, []);

  // Release native players + listeners on unmount (e.g. same-device account switch,
  // which remounts the whole per-user tree). expo-audio players are unmanaged.
  useEffect(() => () => {
    adStatusSubRef.current?.remove();
    if (adWatchdogRef.current) clearTimeout(adWatchdogRef.current);
    TrackPlayer.reset().catch(() => {});
    try { adSoundRef.current?.remove(); } catch {}
  }, []);

  // Self-healing lock-screen card: if ANYTHING wipes the now-playing info
  // while a track is loaded (a stray native session touch — see the
  // patches/expo-video patch — or an OS hiccup), re-push the current track's
  // metadata on every return to the foreground. Streaming in Laybell must
  // ALWAYS have its iOS card.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      // Leaving the foreground: push the buffered licence meter before the OS can
      // freeze or evict us. Losing a partial minute per session sounds trivial,
      // but it compounds into a systematic undercount — and undercounting is what
      // terminates the BMI licence without warning.
      if (s !== 'active') { flushMeter(); return; }
      // Mid-ad: keep the card on the AD, not the paused song underneath it (the
      // ad status ticks would re-correct within ~1s anyway, but repaint now so
      // there's no flash of the song).
      if (adPlayingRef.current && adMetaRef.current) {
        pushAdNowPlaying(adMetaRef.current, adCardPosRef.current, adCardDurRef.current);
        return;
      }
      if (!mainLoadedRef.current) return;
      pushCurrentTrackNowPlaying();
    });
    return () => sub.remove();
  }, []);

  // Lock-screen / Control Center commands drive the SAME functions as the
  // in-app buttons (lib/trackPlayerService routes them here) — the two
  // surfaces can never drift. The ref indirection keeps the registered
  // handlers stable while always calling the latest closures.
  const remoteRef = useRef({ resume, pause, next, previous, seekTo });
  remoteRef.current = { resume, pause, next, previous, seekTo };
  // Lock-screen heart state for the CURRENT track. Held in a ref, not state:
  // nothing in the app renders from it (the in-app heart lives in NowPlaying
  // with its own stats cache), so putting it in state would re-render every
  // useAudio() consumer for a value only the iOS card reads.
  const likedRef = useRef(false);

  // Repaint the heart whenever the track changes. An audio AD repaints this
  // card with the ad's metadata, and an ad is not likeable — so the heart is
  // forced off for the duration rather than showing the underlying song's
  // state against the ad's title.
  useEffect(() => {
    const pid = currentTrack?.id;
    const uid = uidRef.current;
    if (!pid || !uid || adState) {
      likedRef.current = false;
      setNowPlayingLiked(false);
      return;
    }
    let alive = true;
    fetchSongLiked(pid, uid).then((liked) => {
      if (!alive) return;
      likedRef.current = liked;
      setNowPlayingLiked(liked);
    });
    return () => { alive = false; };
  }, [currentTrack?.id, adState]);

  const likeCurrent = useCallback(async () => {
    const pid = currentTrack?.id;
    const uid = uidRef.current;
    if (!pid || !uid || adState) return;
    // Read the truth before flipping rather than trusting the cached value.
    // The in-app heart in NowPlaying writes the same rows, so the cache can be
    // one press behind — and a lock-screen heart that toggles the WRONG way is
    // far worse than one that takes an extra round trip to answer.
    const current = await fetchSongLiked(pid, uid);
    const next = !current;
    likedRef.current = next;
    setNowPlayingLiked(next);
    // Paint the in-app player in the same breath as the lock screen — reopening
    // the app to a heart that disagrees with the one just pressed is the whole
    // bug this avoids. setSongLike republishes the confirmed state after.
    publishSongLike(pid, next);
    // setSongLike returns the state actually reached, so a failed write lands
    // the heart back where it started instead of lying.
    const reached = await setSongLike(pid, uid, next);
    likedRef.current = reached;
    setNowPlayingLiked(reached);
  }, [currentTrack?.id, adState]);

  const likeRef = useRef(likeCurrent);
  likeRef.current = likeCurrent;

  // The other direction: an in-app like on the CURRENT song repaints the lock
  // screen. Without this the card kept the state it was given at track change,
  // so liking in the app left the two hearts disagreeing for the whole song.
  useEffect(() => subscribeSongLike(({ postId, liked }) => {
    if (postId !== currentTrack?.id || adState) return;
    likedRef.current = liked;
    setNowPlayingLiked(liked);
  }), [currentTrack?.id, adState]);

  useEffect(() => {
    setRemoteHandlers({
      play: () => remoteRef.current.resume(),
      pause: () => remoteRef.current.pause(),
      next: () => remoteRef.current.next(),
      previous: () => remoteRef.current.previous(),
      seekTo: (ms: number) => remoteRef.current.seekTo(ms),
      like: () => { likeRef.current(); },
    });
    return () => setRemoteHandlers(null);
  }, []);

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
    pendingFinishRef.current = false;
    saveProgress();
    flushBadgeMs();
    // Tear down any in-flight audio ad. The session ad CLOCK deliberately
    // survives a stop — exiting a song and picking another keeps accruing
    // toward the same break (and keeps an already-due break due).
    adPlayingRef.current = false;
    adMetaRef.current = null;
    if (adWatchdogRef.current) { clearTimeout(adWatchdogRef.current); adWatchdogRef.current = null; }
    adStatusSubRef.current?.remove(); adStatusSubRef.current = null;
    releaseSound(adSoundRef.current); adSoundRef.current = null;
    setAdState(null);
    playTokenRef.current++; // cancel any in-flight load
    pendingStartIndexRef.current = null;
    TrackPlayer.reset().catch(() => {}); // stops audio + clears the lock-screen card
    mainLoadedRef.current = false;
    if (loadedIdRef.current) { clearInUse(loadedIdRef.current); loadedIdRef.current = null; }
    setExpanded(false);
    setIsPlaying(false);
    setIsBuffering(false);
    setCurrentTrack(null);
    emitPosition(0, 0);
  }

  async function pause() {
    if (mainLoadedRef.current) {
      TrackPlayer.pause().catch(() => {});
      setIsPlaying(false);
      saveProgress();
      flushBadgeMs();
    }
  }

  async function resume() {
    // Locked during an audio ad — this also covers the lock-screen play button.
    if (adPlayingRef.current) return;
    if (mainLoadedRef.current) {
      // Pressing play supersedes a deferred song-end — the track isn't "finished" anymore.
      pendingFinishRef.current = false;
      // -600ms: covers both a true run-to-the-end AND the comment-hold pause,
      // which now catches a finishing track ~450ms before its end.
      if (durationRef.current > 0 && positionRef.current >= durationRef.current - 600) {
        // The track ran to the end and was held open for comments: replay from the
        // top (a fresh listen, so near-end engagement re-arms cleanly).
        engagedNearEndRef.current = false;
        progressRef.current = 0;
        positionRef.current = 0;
        TrackPlayer.seekTo(0).then(() => TrackPlayer.play()).catch(() => {});
      } else {
        // Mid-track (incl. after the user scrubbed back) — resume from here.
        TrackPlayer.play().catch(() => {});
      }
      setIsPlaying(true);
    } else if (currentTrack) {
      // Track already torn down — reload and replay the current track from the top.
      pendingFinishRef.current = false;
      await play(currentTrack, true, true);
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
    if (adPlayingRef.current) return; // controls are locked during an audio ad
    if (mainLoadedRef.current) {
      emitPosition(ms, durationRef.current); // reflect immediately so the scrubber doesn't snap back
      progressRef.current = durationRef.current > 0 ? ms / durationRef.current : 0;
      // A scrub/rewind resets the edge case: near-end engagement clears and any
      // deferred finish is cancelled, so the track behaves like a normal one again
      // and must be re-engaged past 80% to hold the song open.
      engagedNearEndRef.current = false;
      pendingFinishRef.current = false;
      TrackPlayer.seekTo(ms / 1000).catch(() => {});   // RNTP uses SECONDS
    }
  }

  // Universal "the music keeps going" loader: when a song starts WITHOUT a
  // curated loader (a post card, an Explore tile, a profile row, a playlist
  // that ran dry…), this pulls in more relevant songs — so next/previous (in
  // app AND on the lock screen) ALWAYS have somewhere to go. Same recipe as
  // the home feed's loader: recent public songs, affinity-scored. Reuses the
  // ad viewer's cached affinity profile (armed on the first real play).
  const defaultSongLoader: QueueLoader = async (excludeIds) => {
    const { data } = await supabase
      .from('posts')
      .select(`*, profiles!posts_user_id_fkey (username, display_name)`)
      .eq('type', 'audio').eq('is_public', true)
      .order('created_at', { ascending: false })
      .limit(120);
    const now = Date.now();
    const affinity = adViewerRef.current?.affinity ?? EMPTY_PROFILE;
    return (data ?? [])
      .filter((p: any) => p.media_url && !p.archived_at && !excludeIds.has(p.id))
      .map((p: any) => ({ p, s: scorePost(p, affinity, new Set(), new Set(), now) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map(({ p }): Track => ({
        id: p.id,
        uri: p.media_url,
        caption: p.caption ?? '',
        artist: p.profiles?.display_name ?? p.profiles?.username ?? '',
        cover: p.cover_url ?? null,
      }));
  };

  async function playQueue(tracks: Track[], startIndex = 0, loadMore?: QueueLoader) {
    if (!tracks.length) return;
    queueRef.current = tracks;
    queueIndexRef.current = startIndex;
    // No curated loader → fall back to the universal one, so even a finished
    // playlist rolls on into related songs instead of dead-ending.
    queueLoaderRef.current = loadMore ?? defaultSongLoader;
    setHasMore(true);
    setQueueLength(tracks.length);
    setQueueIndex(startIndex);
    // The session-wide ad clock keeps running — play() arms the viewer and
    // handles any due break; a new playlist never resets accrued listening.
    await play(tracks[startIndex], true);
  }

  // Pull more relevant tracks from the registered loader (home-feed queue) and
  // append them, so "next" / auto-advance never dead-end. Returns whether the
  // queue grew. Dedupes against what's already queued.
  async function appendFromLoader(): Promise<boolean> {
    const loader = queueLoaderRef.current;
    if (!loader) return false;
    // JOIN an in-flight fetch rather than reporting failure.
    //
    // This used to `return false` when one was already running — indistinguishable
    // from "the loader is dry". advanceOrEnd reads that as the end of the queue and
    // calls endQueue(), so a track finishing during a pre-extension fetch CLOSED
    // THE PLAYER while more songs were already on their way; the late loader then
    // appended into a queue nobody was listening to. Returning the same promise
    // gives every caller the real answer.
    if (inflightAppendRef.current) return inflightAppendRef.current;
    const run = (async (): Promise<boolean> => {
      // The queue can be REBUILT while the loader is out — play()/startQueue bump
      // playTokenRef. Without this, tracks chosen for a queue that no longer exists
      // get spliced into the one that replaced it, and TrackPlayer.add can land
      // inside startQueue's reset+add window.
      const epoch = playTokenRef.current;
      try {
        const more = await loader(new Set(queueRef.current.map((t) => t.id)));
        if (epoch !== playTokenRef.current) return false;
        const fresh = (more ?? []).filter((t) => !queueRef.current.some((q) => q.id === t.id));
        if (fresh.length) {
          queueRef.current = [...queueRef.current, ...fresh];
          setQueueLength(queueRef.current.length);
          // Mirror into the ENGINE queue: the lock screen's NEXT button and
          // native auto-advance see the new tracks the moment we do.
          if (mainLoadedRef.current) {
            try {
              const items = await Promise.all(fresh.map(async (t) => ({
                url: (await resolveLocalUri(t.id, t.uri)) ?? t.uri,
                title: t.caption || t.artist || 'Laybell',
                artist: t.artist || '',
                artwork: t.cover || undefined,
              })));
              // Re-check after the URI resolution above — another await, another
              // chance for the queue to have been replaced underneath us.
              if (epoch !== playTokenRef.current) return false;
              await TrackPlayer.add(items);
            } catch {}
          }
          return true;
        }
        // Loader is dry — stop advertising "more" so the UI can settle.
        queueLoaderRef.current = null;
        setHasMore(false);
      } catch { /* keep the loader; a transient failure shouldn't kill the queue */ }
      return false;
    })();
    inflightAppendRef.current = run;
    try { return await run; } finally { inflightAppendRef.current = null; }
  }

  // Advance to a (now-valid) queue index — a native skip within the engine
  // queue, so the lock-screen card follows instantly. A due ad fires at the
  // boundary via the ActiveTrackChanged handler (pause at 0:00 → ad → restart).
  function advanceTo(ni: number) {
    pendingFinishRef.current = false;
    engagedNearEndRef.current = false;
    pendingStartIndexRef.current = null; // a manual skip supersedes any in-flight start
    queueIndexRef.current = ni;
    setQueueIndex(ni);
    setIsPlaying(true);
    setIsBuffering(true);
    TrackPlayer.skip(ni).then(() => TrackPlayer.play()).catch(() => {});
  }

  function next() {
    if (adPlayingRef.current) return; // locked during an audio ad
    const ni = queueIndexRef.current + 1;
    if (ni < queueRef.current.length) { advanceTo(ni); return; }
    // At the end of the loaded queue — fetch more relevant songs, then skip.
    appendFromLoader().then((grew) => { if (grew) advanceTo(ni); });
  }

  // Restart the current track from the top — used by the Spotify-style "previous"
  // rule below (and when there's no earlier track to go to).
  function restartCurrent() {
    if (mainLoadedRef.current) {
      pendingFinishRef.current = false;
      engagedNearEndRef.current = false;
      progressRef.current = 0;
      emitPosition(0, durationRef.current);
      setIsPlaying(true);
      TrackPlayer.seekTo(0).then(() => TrackPlayer.play()).catch(() => {});
    } else if (currentTrack) {
      play(currentTrack, true, true);
    }
  }

  // Spotify-style previous: more than 3s into the track, it restarts the current
  // song; within the first 3s it jumps to the previous track (restarting the
  // current one if there isn't an earlier track).
  function previous() {
    if (adPlayingRef.current) return; // locked during an audio ad
    const q = queueRef.current;
    const pi = queueIndexRef.current - 1;
    if (positionRef.current < 3000 && q.length && pi >= 0) {
      advanceTo(pi);
    } else {
      restartCurrent();
    }
  }

  // Tear the queue down to the idle state (no track, empty queue) — the player
  // closes. The end-of-the-line outcome when the LAST track finishes.
  function endQueue() {
    setIsPlaying(false);
    setIsBuffering(false);
    setCurrentTrack(null);
    emitPosition(0, 0);
    pendingStartIndexRef.current = null;
    TrackPlayer.reset().catch(() => {}); // clears the lock-screen card too
    mainLoadedRef.current = false;
    if (loadedIdRef.current) { clearInUse(loadedIdRef.current); loadedIdRef.current = null; }
    queueRef.current = [];
    queueIndexRef.current = 0;
    queueLoaderRef.current = null;
    setHasMore(false);
    setQueueLength(0);
    setQueueIndex(0);
    // The session ad clock keeps its accrual — the next listen continues it.
  }

  // The normal "track finished" outcome: advance to the next track in the queue
  // (a playlist plays on), or close if this was the last one.
  function advanceOrEnd() {
    const nextIdx = queueIndexRef.current + 1;
    if (nextIdx < queueRef.current.length) { advanceTo(nextIdx); return; }
    // Last loaded track finished — try to pull in more relevant songs so playback
    // rolls on (appendFromLoader extends the engine queue too); only close the
    // player if the loader is genuinely dry.
    setIsBuffering(true);
    // Capture the epoch too. appendFromLoader now returns false when the queue was
    // rebuilt mid-fetch, and without this that false would be read as "dry" and
    // CLOSE a player that a fresh play() had just opened on a new song. When a new
    // play owns the player, neither advancing nor ending is ours to do.
    const epoch = playTokenRef.current;
    appendFromLoader().then((grew) => {
      if (epoch !== playTokenRef.current) return;
      if (grew) advanceTo(queueIndexRef.current + 1);
      else endQueue();
    });
  }

  // The track is done and nothing is holding the player open. If an audio ad came
  // due during the track, play it BETWEEN songs FIRST — ads never interrupt a song
  // mid-play. The ad runs on its own sound; finishAudioAd re-enters the deferred
  // path (pendingFinishRef) to advance once it ends. Otherwise advance/close now.
  function proceedToNextTrack() {
    if (adDueRef.current && !adPlayingRef.current) {
      adDueRef.current = false;
      pendingFinishRef.current = true; // tells finishAudioAd to advance, not resume
      setIsPlaying(false);
      fireAudioAd();
      return;
    }
    advanceOrEnd();
  }

  // A track finished. If the user is composing, or was interacting with the comments
  // past 80%, keep the current track + comments on screen (just stop playback) and
  // defer the advance/close — so a playlist won't skip ahead, and the player won't
  // exit, out from under an active comment. Otherwise advance/close right away.
  function handleTrackFinished() {
    // A track finishing WHILE an audio ad is playing must not advance the queue
    // under the ad (which would overlap audio and lose the resume position) —
    // defer it; finishAudioAd runs the deferred advance when the ad ends.
    if (adPlayingRef.current) {
      pendingFinishRef.current = true;
      setIsPlaying(false);
      return;
    }
    if (holdForCommentRef.current || engagedNearEndRef.current) {
      // Keep the finished sound loaded + on screen so the user can replay or scrub
      // it while they're still in the comments (see resume / seekTo).
      pendingFinishRef.current = true;
      setIsPlaying(false);
      setIsBuffering(false);
      return;
    }
    proceedToNextTrack();
  }

  // Once nothing holds the player open (not composing, not engaged), run the deferred
  // finish: play a due ad between songs, then advance to the next queued track (or
  // close if it was the last).
  function maybeRunDeferredFinish() {
    // While an audio ad is playing, NEVER advance here — the music is paused
    // under the ad and finishAudioAd runs the advance when the ad ends. (Collapsing
    // the player mid-ad calls this; without the guard it would start the next song
    // on top of the ad.)
    if (adPlayingRef.current) return;
    if (pendingFinishRef.current && !holdForCommentRef.current && !engagedNearEndRef.current) {
      pendingFinishRef.current = false;
      proceedToNextTrack();
    }
  }

  // Now Playing reports composing state (input focused, a draft, or a reply).
  function setCommentComposing(composing: boolean) {
    holdForCommentRef.current = composing;
    if (!composing) maybeRunDeferredFinish();
  }

  // Now Playing reports a comment-section touch (scroll, like, type, reply). Past
  // 80% of the track it arms the keep-open hold, so a finishing track won't advance
  // or exit — until the user finishes (manually leaves for the mini player).
  function noteCommentEngagement() {
    if (progressRef.current >= 0.8) engagedNearEndRef.current = true;
  }

  // Now Playing reports the comments were scrolled back to the very top — the user
  // has left the comment area, so the edge case exits as if it were never triggered.
  // If a finished track was held open only by this, it now advances/closes.
  function clearCommentEngagement() {
    engagedNearEndRef.current = false;
    maybeRunDeferredFinish();
  }

  // Bookkeeping for the track that just became ACTIVE — initial load, native
  // auto-advance, next/previous, lock-screen skips ALL pass through the
  // ActiveTrackChanged event, so this is the one arming path.
  function armTrack(track: Track) {
    // Every main-player listen accrues toward ad breaks — resolve the ad
    // viewer once per session, on the first real play.
    if (!adViewerRef.current) armAdViewer();
    // Music-badge accounting: reset the per-song 10-min cap only when the SONG
    // changes (loops/replays of the same song keep sharing its budget).
    // Eligibility defaults OFF until ownership resolves — only OTHER
    // creators' songs count (no self-loop farming).
    if (badgeSongIdRef.current !== track.id) {
      badgeSongIdRef.current = track.id;
      badgeSongMsRef.current = 0;
    }
    badgeEligibleRef.current = false;
    // Swap the offline in-use lock to the new track.
    if (loadedIdRef.current && loadedIdRef.current !== track.id) clearInUse(loadedIdRef.current);
    loadedIdRef.current = track.id;
    markInUse(track.id);
    (async () => {
      try {
        const u = (await supabase.auth.getUser()).data.user;
        if (u) uidRef.current = u.id;
        const { data: ownerRow } = await supabase.from('posts').select('user_id, downloadable').eq('id', track.id).single();
        badgeEligibleRef.current = !!u && !!ownerRow && ownerRow.user_id !== u.id;
        // Layer-0 safety net: opportunistically cache this track for offline.
        void autoCache(track.id, track.uri, {
          title: track.caption, artist: track.artist, cover: track.cover,
          downloadable: (ownerRow as any)?.downloadable !== false,
        });
        // Deliberate main-player plays feed the local listen history that
        // drives offline prefetch (the ambient feed-song player never counts).
        if (u) void recordListen(u.id,
          { id: track.id, uri: track.uri, title: track.caption, artist: track.artist, cover: track.cover ?? null },
          (ownerRow as any)?.downloadable !== false);
      } catch { badgeEligibleRef.current = false; }
    })();
  }

  // Route a stream credit through the offline outbox (records now when online,
  // queues for replay on reconnect when offline).
  const recordStreamFor = (postId: string) => {
    const uid = uidRef.current;
    if (uid) recordStreamDurable(uid, postId, deviceIdRef.current);
    else supabase.rpc('record_stream', { p_post_id: postId, p_device_id: deviceIdRef.current }).then(undefined, () => {});
  };

  // ── GLOBAL engine listeners (attached ONCE) ─────────────────────────────────
  // The RNTP queue advances natively (that's what keeps the lock screen and
  // Laybell on the SAME queue, foreground or not), so these listeners are
  // permanent instead of per-play — no attach/detach races.
  useEffect(() => {
    const progressSub = TrackPlayer.addEventListener(TPEvent.PlaybackProgressUpdated, (e) => {
      const pos = (e.position ?? 0) * 1000;   // RNTP reports SECONDS
      const dur = (e.duration ?? 0) * 1000;
      // During an audio ad the position channel belongs to the AD's ticks.
      if (!adPlayingRef.current) emitPosition(pos, dur);
      progressRef.current = dur > 0 ? pos / dur : 0;

      // The music-video handoff, resolved on the first tick that carries a real
      // duration. handoffPositionMs answers 0 for everything it cannot vouch
      // for, and 0 means "from the top" — so the failure mode of a mislabelled
      // music video is an ordinary play, never a wrong seek.
      const handoff = pendingSeekRef.current;
      if (handoff && dur > 0 && !adPlayingRef.current) {
        clearPendingSeek();
        const at = handoffPositionMs(handoff.atMs, dur, handoff.sourceMs);
        if (at > 0 && handoff.id === loadedIdRef.current) seekTo(at);
      }

      // Comment-hold: with native advance, a finishing track must be CAUGHT
      // just before its end (the engine won't wait for JS) — pause it and
      // defer the advance, exactly like the old didJustFinish hold. resume()
      // treats this near-end pause as "finished" (replay-from-top rule).
      if ((holdForCommentRef.current || engagedNearEndRef.current)
        && dur > 0 && pos >= dur - 450
        && !pendingFinishRef.current && !adPlayingRef.current) {
        pendingFinishRef.current = true;
        TrackPlayer.pause().catch(() => {});
        setIsPlaying(false);
        setIsBuffering(false);
        saveProgress();
        flushBadgeMs();
        return;
      }

      // --- Stream counting policy (unchanged semantics) ---
      // Accumulate genuine forward listen time (ignore seeks, rewinds and the
      // jump on finish), then credit streams as cumulative listening crosses
      // this track's duration-scaled thresholds. The server (record_stream)
      // stays the authority on eligibility.
      const id = loadedIdRef.current;
      if (uidRef.current && id && dur > 0) {
        const delta = pos - lastPosMsRef.current;
        if (delta > 0 && delta < 1500) {
          // BMI licence meter. This sits alongside the creator-credit logic below
          // rather than inside it, because the two count different things: stream
          // CREDIT is capped and deduped, while the licence counts every hour
          // actually transmitted. `delta` is already genuine forward playback —
          // seeks and the end-of-track jump are excluded by the guard above —
          // which is exactly BMI's definition. See lib/listenMeter.ts.
          meterPlayback(delta, 'audio');
          // Daily music badge: only OTHER creators' songs (badgeEligibleRef),
          // capped per song (badgeSongMsRef) so loops can't farm it.
          if (badgeEligibleRef.current && badgeSongMsRef.current < BADGE_SONG_CAP_MS) {
            const credit = Math.min(delta, BADGE_SONG_CAP_MS - badgeSongMsRef.current);
            badgeSongMsRef.current += credit;
            badgeMsRef.current += credit;
            if (badgeMsRef.current >= 15000) flushBadgeMs();
          }
          // Audio-ad clock: every genuine main-player listen ms counts,
          // session-wide. Crossing the threshold marks a break DUE — it fires
          // at the next song boundary, never mid-play.
          if (!adPlayingRef.current) {
            adListenMsRef.current += delta;
            if (adListenMsRef.current >= adNextThresholdRef.current) adDueRef.current = true;
          }
          // Reset a post's accounting once its 24h window elapses (mirrors the
          // server cap window).
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
            recordStreamFor(id);
            saveProgress();
          } else if (awarded === 1 && listened >= t2 * 1000) {
            streamsAwardedRef.current[id] = 2;
            recordStreamFor(id);
            saveProgress();
          } else if (awarded === 2 && listened >= t3 * 1000) {
            // 3rd stream — credited by the server only for accounts >24h old.
            streamsAwardedRef.current[id] = 3;
            recordStreamFor(id);
            saveProgress();
          }
        }
      }
      lastPosMsRef.current = pos;
    });

    // Buffering + play/pause mirrored from the ENGINE, so lock-screen taps and
    // call interruptions (autoHandleInterruptions) keep the in-app buttons in
    // sync with what's actually audible. Buffering is DEBOUNCED: streaming
    // tops its buffer up in short bursts, and flashing the buffering UI (and
    // the card's rate) for every sub-second blip made the player visibly
    // "flash every few seconds" — only SUSTAINED buffering (>600ms) shows.
    const stateSub = TrackPlayer.addEventListener(TPEvent.PlaybackState, (e) => {
      const buffering = e.state === TPState.Buffering || e.state === TPState.Loading;
      if (buffering) {
        if (!bufferingDebounceRef.current) {
          bufferingDebounceRef.current = setTimeout(() => {
            bufferingDebounceRef.current = null;
            setIsBuffering(true);
          }, 600);
        }
      } else {
        if (bufferingDebounceRef.current) { clearTimeout(bufferingDebounceRef.current); bufferingDebounceRef.current = null; }
        setIsBuffering(false);
      }
      if (e.state === TPState.Playing) setIsPlaying(true);
      else if (e.state === TPState.Paused && !adPlayingRef.current && !pendingFinishRef.current) setIsPlaying(false);
    });

    // A different track became active — native auto-advance, next/previous, a
    // lock-screen skip, or the initial load. Sync Laybell to the ENGINE (the
    // engine is the source of truth for "which track"), arm the new track's
    // accounting, run a due ad at this boundary, and keep the queue extended.
    const trackSub = TrackPlayer.addEventListener(TPEvent.PlaybackActiveTrackChanged, (e: any) => {
      const idx = typeof e?.index === 'number' ? e.index : -1;
      if (idx < 0 || idx >= queueRef.current.length) return;
      // Queue start in flight: swallow the intermediate index-0 load event;
      // only the intended start index unlatches (see pendingStartIndexRef).
      const pending = pendingStartIndexRef.current;
      if (pending != null) {
        if (idx !== pending) return;
        pendingStartIndexRef.current = null;
      }
      const t = queueRef.current[idx];
      if (!t) return;
      // IDEMPOTENT: iOS can re-emit this for the SAME track (buffer/seek
      // edges). A re-arm here snapped the scrubber to 0 and re-ran per-track
      // bookkeeping — a visible flash. Same-track re-emissions only keep the
      // queue-extension check alive (covers replaying a single track too).
      if (idx === queueIndexRef.current && loadedIdRef.current === t.id) {
        if (idx >= queueRef.current.length - 2 && queueLoaderRef.current) void appendFromLoader();
        return;
      }
      queueIndexRef.current = idx;
      setQueueIndex(idx);
      setCurrentTrack(t);
      armTrack(t);
      // Fresh per-track edge state + accounting deltas.
      pendingFinishRef.current = false;
      engagedNearEndRef.current = false;
      progressRef.current = 0;
      positionRef.current = 0;
      lastPosMsRef.current = 0;
      if (!adPlayingRef.current) emitPosition(0, 0);
      // A due break fires HERE, at the song boundary (never mid-play): the
      // just-changed track is still at ~0:00 — pause it, play the ad, and
      // finishAudioAd restarts it from the top.
      if (adDueRef.current && !adPlayingRef.current) {
        adDueRef.current = false;
        TrackPlayer.pause().catch(() => {});
        setIsPlaying(false);
        fireAudioAd();
      }
      // Keep the lock screen's NEXT button alive: extend the queue before the
      // engine runs out of tracks (appendFromLoader mirrors into RNTP).
      if (idx >= queueRef.current.length - 2 && queueLoaderRef.current) void appendFromLoader();
    });

    // The queue genuinely ran out (last track played to its end). GENUINE-END
    // GUARD: iOS can fire this spuriously at track load — trusting it blindly
    // "finished" a fresh song ~0.2s in. Only a playhead at the end counts.
    const endSub = TrackPlayer.addEventListener(TPEvent.PlaybackQueueEnded, () => {
      const dur = durationRef.current;
      const pos = positionRef.current;
      if (dur <= 0 || pos < Math.min(dur - 2000, dur * 0.95)) return;
      saveProgress();
      flushBadgeMs();
      handleTrackFinished();
    });

    return () => {
      progressSub.remove(); stateSub.remove(); trackSub.remove(); endSub.remove();
      if (bufferingDebounceRef.current) { clearTimeout(bufferingDebounceRef.current); bufferingDebounceRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the CURRENT queueRef into the engine and start at startIndex. From
  // here the ENGINE owns the whole queue — native auto-advance and lock-screen
  // next/previous stay aligned with queueRef by index.
  async function startQueue(startIndex: number) {
    const token = ++playTokenRef.current;
    const tracks = queueRef.current;
    const startTrack = tracks[startIndex];
    if (!startTrack) return;
    // Captured BEFORE any await: the ActiveTrackChanged handler arms the new
    // track (and overwrites loadedIdRef) as soon as the engine loads it.
    const previousSongId = loadedIdRef.current;
    setCurrentTrack(startTrack);
    setIsPlaying(true);
    setIsBuffering(true);
    emitPosition(0, 0);
    setVideoMuted(true); // a song is playing → mute feed video to avoid overlap
    try {
      // Offline: per track, play the verified local copy when present;
      // otherwise stream the remote URL.
      const items = await Promise.all(tracks.map(async (t) => ({
        url: (await resolveLocalUri(t.id, t.uri)) ?? t.uri,
        title: t.caption || t.artist || 'Laybell',
        artist: t.artist || '',
        artwork: t.cover || undefined,
      })));
      if (token !== playTokenRef.current) return;
      await ensurePlayerSetup();
      if (token !== playTokenRef.current) return;
      await TrackPlayer.reset();
      if (token !== playTokenRef.current) return;
      // Latch BEFORE add: loading the queue emits an index-0 track-change
      // before the skip below lands — the handler ignores it (wrong-song
      // flash on the mini-player otherwise).
      pendingStartIndexRef.current = startIndex;
      await TrackPlayer.add(items);
      if (token !== playTokenRef.current) { TrackPlayer.reset().catch(() => {}); return; }
      // Only take our start index if nothing superseded it while we were loading.
      // advanceTo() nulls this latch precisely to say "the user has moved on" — but
      // this skip used to run anyway and yank them BACK to startIndex, so a skip
      // during a load silently reverted itself. The token guards above do not cover
      // it: advanceTo deliberately does not bump playTokenRef, because two of those
      // guards reset the engine queue and advanceTo needs that queue to skip within.
      if (pendingStartIndexRef.current === startIndex && startIndex > 0) {
        await TrackPlayer.skip(startIndex);
      }
      if (token !== playTokenRef.current) { TrackPlayer.reset().catch(() => {}); return; }
      mainLoadedRef.current = true;
      // A break is due and the user just MOVED to a different song: the ad
      // plays FIRST — the fresh track is loaded but never started, and every
      // fireAudioAd outcome (finish, skip, failure, no inventory) starts it
      // from 0:00. (Restarting the SAME song isn't a move; it stays ad-free.)
      const adFirst = adDueRef.current && !adPlayingRef.current && previousSongId !== startTrack.id;
      if (adFirst) {
        // An ad break has already broken the seamlessness the handoff was for,
        // and every fireAudioAd outcome starts the track from 0:00 — so drop the
        // seek rather than have it land on a song the listener is now hearing
        // from the top.
        clearPendingSeek();
        adDueRef.current = false;
        setIsPlaying(false);
        fireAudioAd();
      } else {
        TrackPlayer.play().catch(() => {});
      }
    } catch (err) {
      console.log('audio error:', err);
      pendingStartIndexRef.current = null; // failed load must not latch the handler shut
      setIsPlaying(false);
      setIsBuffering(false);
      setCurrentTrack(null);
    }
  }

  async function play(
    track: Track, fromQueue = false, suppressToggle = false,
    handoff?: { atMs: number; sourceMs: number },
  ) {
    pendingFinishRef.current = false;  // a fresh play cancels any deferred advance/close
    engagedNearEndRef.current = false; // and resets near-end engagement for the new track
    progressRef.current = 0;
    positionRef.current = 0;
    // Set (or cleared) on EVERY play, so an unused handoff can never sit around
    // waiting to hijack an unrelated song started later.
    pendingSeekRef.current = handoff && handoff.atMs > 0 ? { ...handoff, id: track.id } : null;
    // A fresh play supersedes any in-flight audio ad (e.g. tapping a feed track
    // while a playlist break is on screen) — tear the ad down like stop() does.
    if (adPlayingRef.current) {
      adPlayingRef.current = false;
      adMetaRef.current = null;
      if (adWatchdogRef.current) { clearTimeout(adWatchdogRef.current); adWatchdogRef.current = null; }
      adStatusSubRef.current?.remove(); adStatusSubRef.current = null;
      releaseSound(adSoundRef.current); adSoundRef.current = null;
      setAdState(null);
    }
    // Single-track taps clear the queue but never the session ad clock — and
    // ALWAYS get the universal loader, so every song tapped anywhere in
    // Laybell has a real path forward: the queue extends immediately (the
    // ActiveTrackChanged pre-extension fires on load) and next/previous work
    // in app and on the lock screen.
    if (!fromQueue) {
      queueRef.current = [];
      queueIndexRef.current = 0;
      setQueueLength(0);
      setQueueIndex(0);
      queueLoaderRef.current = defaultSongLoader;
      setHasMore(true);
    }
    // Tapping the already-playing track in a list toggles it off. Queue navigation
    // (next / previous / restart / advance) must always play its target — never
    // stop and close the player — so it passes suppressToggle to skip this.
    if (!suppressToggle && currentTrack?.id === track.id && isPlaying) {
      clearPendingSeek();
      await stop();
      return;
    }
    if (!fromQueue || !queueRef.current.length) {
      // Single track → a one-track engine queue.
      queueRef.current = [track];
      queueIndexRef.current = 0;
      setQueueLength(1);
      setQueueIndex(0);
    } else {
      // Playing out of the existing queue (playQueue start, resume reload):
      // align the index to the requested track.
      const qi = queueRef.current.findIndex((t) => t.id === track.id);
      if (qi >= 0) queueIndexRef.current = qi;
      setQueueIndex(queueIndexRef.current);
    }
    await startQueue(queueIndexRef.current);
  }

  const playFrom = (track: Track, atMs: number, sourceMs: number) =>
    play(track, false, false, { atMs, sourceMs });

  // Keep the now-playing module store + stable play accessor in sync, so
  // useNowPlaying() consumers (Explore grid, track rails) re-render on ONLY a
  // track change / play-pause — not on this provider's buffering/ad/queue churn.
  useEffect(() => {
    latestPlay = play;
    latestPlayQueue = playQueue;
    latestStop = stop;
    latestExpand = expand;
    latestToggleVideoMuted = toggleVideoMuted;
  });
  useEffect(() => { publishNowPlaying(currentTrack?.id ?? null, isPlaying); }, [currentTrack?.id, isPlaying]);
  useEffect(() => { publishVideoMuted(videoMuted); }, [videoMuted]);

  return (
    <AudioContext.Provider value={{ currentTrack, isPlaying, isBuffering, play, playFrom, playQueue, setCommentComposing, noteCommentEngagement, clearCommentEngagement, pause, resume, stop, seekTo, expanded, expand, collapse, next, previous, queueIndex, queueLength, hasMore, videoMuted, toggleVideoMuted, adState, skipAudioAd }}>
      <AudioPositionContext.Provider value={subscribePosition}>
        {children}
      </AudioPositionContext.Provider>
    </AudioContext.Provider>
  );
}

export function useAudio() {
  const ctx = useContext(AudioContext);
  if (!ctx) throw new Error('useAudio must be used within AudioProvider');
  return ctx;
}
