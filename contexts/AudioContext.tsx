import React, { createContext, useContext, useState, useRef, useEffect } from 'react';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import { getDeviceId } from '../lib/deviceId';
import { playThresholds } from '../lib/playThresholds';
import { bumpBadge } from '../lib/badges';
import { resolveLocalUri, markInUse, clearInUse, autoCache } from '../lib/offline';
import { recordListen } from '../lib/listenHistory';
import { recordStream as recordStreamDurable } from '../lib/streamOutbox';
import {
  pickAudioAd, recordAdImpression, recordAdComplete, recordAdSkip,
  AUDIO_AD_FIRST_MS, AUDIO_AD_EVERY_MS, AUDIO_AD_SKIP_MS,
  type AdViewer, type AudioAd,
} from '../lib/ads';
import { buildAffinityProfile, EMPTY_PROFILE } from '../lib/feedScorer';

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
};

type AudioContextType = {
  currentTrack: Track | null;
  isPlaying: boolean;
  isBuffering: boolean;
  play: (track: Track) => Promise<void>;
  playQueue: (tracks: Track[], startIndex?: number) => Promise<void>;
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
  const soundRef = useRef<AudioPlayer | null>(null);
  // Status-listener subscriptions, removed synchronously when we tear a player down
  // so a stray late 'playbackStatusUpdate' from an abandoned player can't fire.
  const statusSubRef = useRef<{ remove: () => void } | null>(null);
  const adStatusSubRef = useRef<{ remove: () => void } | null>(null);
  const queueRef = useRef<Track[]>([]);
  const queueIndexRef = useRef(0);
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
  // Armed ONLY while a real playlist queue plays (playQueue). Accrues genuine
  // forward listen ms across the queue session; fires the first ad at 1 min and
  // every 6 min after. The ad plays on a SEPARATE sound so the music's stream/
  // badge accounting is never touched; the music is paused (not unloaded) and
  // resumes at the same spot when the ad ends/skips.
  const [adState, setAdState] = useState<AudioAdState | null>(null);
  const adArmedRef = useRef(false);
  const adListenMsRef = useRef(0);
  const adNextThresholdRef = useRef(AUDIO_AD_FIRST_MS);
  const adSoundRef = useRef<AudioPlayer | null>(null);
  const adPlayingRef = useRef(false);
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

  // Release an abandoned expo-audio player safely: pause now (sync — stops audio
  // immediately, no overlap) and defer remove() to the next tick, so we never call
  // remove() from inside that player's own 'playbackStatusUpdate' callback (the
  // didJustFinish → advance path runs there).
  function releaseSound(p: AudioPlayer | null) {
    if (!p) return;
    try { p.pause(); } catch {}
    setTimeout(() => { try { p.remove(); } catch {} }, 0);
  }

  function disarmAds() {
    adArmedRef.current = false;
    adListenMsRef.current = 0;
    adNextThresholdRef.current = AUDIO_AD_FIRST_MS;
    adDueRef.current = false;
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
    if (!ad) {
      // No matching inventory — push the next break out.
      adPlayingRef.current = false;
      adNextThresholdRef.current = adListenMsRef.current + AUDIO_AD_EVERY_MS;
      // If this break was scheduled BETWEEN songs (the track already finished and
      // is waiting on the ad), there's nothing to resume — proceed to the next
      // track. Otherwise the music is still playing and just keeps going.
      if (pendingFinishRef.current) maybeRunDeferredFinish();
      return;
    }
    adMetaRef.current = ad;
    try { soundRef.current?.pause(); } catch {}
    setIsPlaying(false);
    flushBadgeMs();
    try {
      adProgressedRef.current = false;
      const player = createAudioPlayer({ uri: ad.uri }, { updateInterval: 250 });
      adSoundRef.current = player;
      setAdState({
        campaignId: ad.campaignId, creativeId: ad.creativeId, ownerId: ad.ownerId,
        advertiserName: ad.advertiserName, headline: ad.headline,
        ctaLabel: ad.ctaLabel, ctaUrl: ad.ctaUrl, cover: ad.cover ?? null,
        viewerId: uidRef.current,
        elapsedMs: 0, durationMs: 0, canSkip: false,
      });
      recordAdImpression(ad, 'audio', uidRef.current);
      adStatusSubRef.current = player.addListener('playbackStatusUpdate', (st: any) => {
        if (!st.isLoaded) return;
        const pos = (st.currentTime ?? 0) * 1000;   // expo-audio reports SECONDS
        const dur = (st.duration ?? 0) * 1000;
        if (pos > 0) adProgressedRef.current = true;
        setAdState((prev) => (prev ? { ...prev, elapsedMs: pos, durationMs: dur, canSkip: pos >= AUDIO_AD_SKIP_MS } : prev));
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
    adNextThresholdRef.current = adListenMsRef.current + AUDIO_AD_EVERY_MS;
    if (pendingFinishRef.current) {
      // The track ended WHILE the ad played (handleTrackFinished deferred it) —
      // advance/close now instead of resuming a finished track.
      maybeRunDeferredFinish();
    } else if (soundRef.current) {
      try { soundRef.current.play(); setIsPlaying(true); } catch {}
    }
  }

  function skipAudioAd() { finishAudioAd(true); }

  // Configure the audio session once up front so the first tap plays immediately
  // (a cold session previously made the first createAsync fail to start).
  useEffect(() => { setAudioModeAsync(AUDIO_MODE).catch(() => {}); }, []);

  // Release native players + listeners on unmount (e.g. same-device account switch,
  // which remounts the whole per-user tree). expo-audio players are unmanaged.
  useEffect(() => () => {
    statusSubRef.current?.remove();
    adStatusSubRef.current?.remove();
    if (adWatchdogRef.current) clearTimeout(adWatchdogRef.current);
    try { soundRef.current?.remove(); } catch {}
    try { adSoundRef.current?.remove(); } catch {}
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
    // Tear down any in-flight audio ad and disarm scheduling.
    adPlayingRef.current = false;
    adMetaRef.current = null;
    if (adWatchdogRef.current) { clearTimeout(adWatchdogRef.current); adWatchdogRef.current = null; }
    adStatusSubRef.current?.remove(); adStatusSubRef.current = null;
    releaseSound(adSoundRef.current); adSoundRef.current = null;
    setAdState(null);
    disarmAds();
    playTokenRef.current++; // cancel any in-flight load
    statusSubRef.current?.remove(); statusSubRef.current = null;
    releaseSound(soundRef.current);
    soundRef.current = null;
    if (loadedIdRef.current) { clearInUse(loadedIdRef.current); loadedIdRef.current = null; }
    setExpanded(false);
    setIsPlaying(false);
    setIsBuffering(false);
    setCurrentTrack(null);
    emitPosition(0, 0);
  }

  async function pause() {
    if (soundRef.current) {
      try { soundRef.current.pause(); } catch {}
      setIsPlaying(false);
      saveProgress();
      flushBadgeMs();
    }
  }

  async function resume() {
    const s = soundRef.current;
    if (s) {
      // Pressing play supersedes a deferred song-end — the track isn't "finished" anymore.
      pendingFinishRef.current = false;
      if (durationRef.current > 0 && positionRef.current >= durationRef.current - 250) {
        // The track ran to the end and was held open for comments: replay from the
        // top (a fresh listen, so near-end engagement re-arms cleanly).
        engagedNearEndRef.current = false;
        progressRef.current = 0;
        positionRef.current = 0;
        s.seekTo(0).then(() => s.play()).catch(() => {});   // expo-audio: reset then play
      } else {
        // Mid-track (incl. after the user scrubbed back) — resume from here.
        try { s.play(); } catch {}
      }
      setIsPlaying(true);
    } else if (currentTrack) {
      // Sound already released — reload and replay the current track from the top.
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
    if (soundRef.current) {
      emitPosition(ms, durationRef.current); // reflect immediately so the scrubber doesn't snap back
      progressRef.current = durationRef.current > 0 ? ms / durationRef.current : 0;
      // A scrub/rewind resets the edge case: near-end engagement clears and any
      // deferred finish is cancelled, so the track behaves like a normal one again
      // and must be re-engaged past 80% to hold the song open.
      engagedNearEndRef.current = false;
      pendingFinishRef.current = false;
      soundRef.current.seekTo(ms / 1000).catch(() => {});   // expo-audio uses SECONDS
    }
  }

  async function playQueue(tracks: Track[], startIndex = 0) {
    if (!tracks.length) return;
    queueRef.current = tracks;
    queueIndexRef.current = startIndex;
    setQueueLength(tracks.length);
    setQueueIndex(startIndex);
    // Arm audio-ad scheduling for THIS playlist session (single-track taps go
    // through play() with fromQueue=false and never arm).
    adArmedRef.current = true;
    adListenMsRef.current = 0;
    adNextThresholdRef.current = AUDIO_AD_FIRST_MS;
    armAdViewer();
    await play(tracks[startIndex], true);
  }

  function next() {
    if (adPlayingRef.current) return; // locked during an audio ad
    const q = queueRef.current;
    const ni = queueIndexRef.current + 1;
    if (!(q.length && ni < q.length)) return; // nothing to skip to
    // An ad is queued up — play it BETWEEN songs first (manual skip counts as
    // "a song finishing"); proceedToNextTrack fires the ad and its completion
    // advances to the song being skipped to (queueIndex + 1).
    if (adDueRef.current && adArmedRef.current) {
      proceedToNextTrack();
      return;
    }
    queueIndexRef.current = ni;
    setQueueIndex(ni);
    play(q[ni], true, true);
  }

  // Restart the current track from the top — used by the Spotify-style "previous"
  // rule below (and when there's no earlier track to go to).
  function restartCurrent() {
    const s = soundRef.current;
    if (s) {
      pendingFinishRef.current = false;
      engagedNearEndRef.current = false;
      progressRef.current = 0;
      emitPosition(0, durationRef.current);
      setIsPlaying(true);
      s.seekTo(0).then(() => s.play()).catch(() => {});   // expo-audio: reset then play
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
      queueIndexRef.current = pi;
      setQueueIndex(pi);
      play(q[pi], true, true);
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
    statusSubRef.current?.remove(); statusSubRef.current = null;
    releaseSound(soundRef.current);
    soundRef.current = null;
    if (loadedIdRef.current) { clearInUse(loadedIdRef.current); loadedIdRef.current = null; }
    queueRef.current = [];
    queueIndexRef.current = 0;
    setQueueLength(0);
    setQueueIndex(0);
    disarmAds(); // the playlist is over — stop the ad clock
  }

  // The normal "track finished" outcome: advance to the next track in the queue
  // (a playlist plays on), or close if this was the last one.
  function advanceOrEnd() {
    const q = queueRef.current;
    const nextIdx = queueIndexRef.current + 1;
    if (q.length && nextIdx < q.length) {
      queueIndexRef.current = nextIdx;
      setQueueIndex(nextIdx);
      // Release the just-finished player (we're inside its status callback, so the
      // listener goes now and the player itself is freed on the next tick).
      statusSubRef.current?.remove(); statusSubRef.current = null;
      releaseSound(soundRef.current);
      soundRef.current = null;
      play(q[nextIdx], true, true);
    } else {
      endQueue();
    }
  }

  // The track is done and nothing is holding the player open. If an audio ad came
  // due during the track, play it BETWEEN songs FIRST — ads never interrupt a song
  // mid-play. The ad runs on its own sound; finishAudioAd re-enters the deferred
  // path (pendingFinishRef) to advance once it ends. Otherwise advance/close now.
  function proceedToNextTrack() {
    if (adDueRef.current && adArmedRef.current && !adPlayingRef.current) {
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
      // Release the finished-but-kept sound before moving on (safe here — we're not
      // inside its own playback-status callback).
      statusSubRef.current?.remove(); statusSubRef.current = null;
      releaseSound(soundRef.current);
      soundRef.current = null;
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

  async function play(track: Track, fromQueue = false, suppressToggle = false) {
    pendingFinishRef.current = false;  // a fresh play cancels any deferred advance/close
    engagedNearEndRef.current = false; // and resets near-end engagement for the new track
    progressRef.current = 0;
    positionRef.current = 0;
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
    if (!fromQueue) { queueRef.current = []; queueIndexRef.current = 0; setQueueLength(0); setQueueIndex(0); disarmAds(); }
    // Tapping the already-playing track in a list toggles it off. Queue navigation
    // (next / previous / restart / advance) must always play its target — never
    // stop and close the player — so it passes suppressToggle to skip this.
    if (!suppressToggle && currentTrack?.id === track.id && isPlaying) {
      await stop();
      return;
    }

    // Each play gets a token; if a newer play starts before this one finishes
    // loading, the older one bails and unloads itself (prevents overlap).
    const token = ++playTokenRef.current;

    // Tear down the existing sound (grab+null first so concurrent calls don't double-release).
    statusSubRef.current?.remove(); statusSubRef.current = null;
    const existing = soundRef.current;
    soundRef.current = null;
    releaseSound(existing);   // pause now (no overlap) + free on next tick
    // Release the previous track's offline in-use lock (the new track locks below).
    if (loadedIdRef.current && loadedIdRef.current !== track.id) { clearInUse(loadedIdRef.current); loadedIdRef.current = null; }

    setCurrentTrack(track);
    setIsPlaying(true);
    setIsBuffering(true);
    emitPosition(0, 0);
    setVideoMuted(true); // a song is playing → mute feed video to avoid overlap

    // Music-badge accounting: reset the per-song 10-min cap only when the SONG
    // changes (loops/replays of the same song keep sharing its budget). Eligibility
    // defaults OFF until ownership resolves below — only OTHER creators' songs count.
    if (badgeSongIdRef.current !== track.id) {
      badgeSongIdRef.current = track.id;
      badgeSongMsRef.current = 0;
    }
    badgeEligibleRef.current = false;

    // --- Stream counting policy ---
    // Credit streams by cumulative listen time, scaled by duration (see
    // streamThresholds): the 1st stream at the tier's 1st threshold, the 2nd once
    // combined listening reaches the 2nd threshold. Genuine forward listen time is
    // accumulated per post across replays this session. The server (record_stream)
    // is the authority on eligibility — it credits the owner's OWN listen exactly
    // once (lifetime), and caps everyone else per the age/device rules.
    // canCount is resolved in the background so playback never waits on the network.
    let canCount = false;
    (async () => {
      try {
        const u = (await supabase.auth.getUser()).data.user;
        canCount = !!u;
        if (u) uidRef.current = u.id;
        // Badge eligibility: only OTHER creators' songs count (no self-loop farming).
        // Resolve this track's owner once; a non-post track (e.g. an ad) returns null
        // and stays ineligible. Per-post stream credit (canCount) is unaffected — the
        // server's record_stream enforces its own self-stream rule.
        const { data: ownerRow } = await supabase.from('posts').select('user_id, downloadable').eq('id', track.id).single();
        badgeEligibleRef.current = !!u && !!ownerRow && ownerRow.user_id !== u.id;
        // Layer-0 safety net: opportunistically cache this track for offline. The
        // engine gates on prefs/network/dedupe and never blocks playback; we pass
        // downloadable from the same row so an opted-out track is never auto-cached.
        void autoCache(track.id, track.uri, {
          title: track.caption, artist: track.artist, cover: track.cover,
          downloadable: (ownerRow as any)?.downloadable !== false,
        });
        // Log this deliberate play to the local listen history that drives the
        // offline prefetch (top-played + recent). Main-player plays only — the
        // ambient feed-song player doesn't count.
        if (u) void recordListen(u.id,
          { id: track.id, uri: track.uri, title: track.caption, artist: track.artist, cover: track.cover ?? null },
          (ownerRow as any)?.downloadable !== false);
      } catch { badgeEligibleRef.current = false; }
    })();
    const recordStream = () => {
      // Route through the offline outbox: it records now when online, and queues the
      // event for replay on reconnect when offline (so an offline listen still
      // credits the creator). Falls back to a direct RPC until the uid resolves.
      const uid = uidRef.current;
      if (uid) recordStreamDurable(uid, track.id, deviceIdRef.current);
      else supabase.rpc('record_stream', { p_post_id: track.id, p_device_id: deviceIdRef.current }).then(undefined, () => {});
    };
    let lastPosMs = 0; // previous reported position, for forward-delta accumulation

    try {
      // Offline: play the local file when we have a verified, non-stale copy of this
      // track; otherwise stream the remote URL. A failed remote stream just means the
      // next play retries — that lazy fallback IS our offline detection.
      const playUri = (await resolveLocalUri(track.id, track.uri)) ?? track.uri;
      // A newer play started during the (async) offline-uri resolve → bail before
      // creating a player, so we never overlap. (createAudioPlayer itself is sync.)
      if (token !== playTokenRef.current) return;
      const player = createAudioPlayer({ uri: playUri }, { updateInterval: 250 });
      soundRef.current = player;
      loadedIdRef.current = track.id;
      markInUse(track.id);  // protect this file from removal/eviction while it's loaded
      player.play();

      statusSubRef.current = player.addListener('playbackStatusUpdate', (status: any) => {
        if (!status.isLoaded) return;
        const pos = (status.currentTime ?? 0) * 1000;   // expo-audio reports SECONDS
        const dur = (status.duration ?? 0) * 1000;
        emitPosition(pos, dur); // ticks go to useAudioPosition subscribers only
        progressRef.current = dur > 0 ? pos / dur : 0;
        setIsBuffering(status.isBuffering ?? false);

        // Accumulate genuine forward listen time (ignore seeks, rewinds and the
        // jump on finish), then credit the 1st/2nd stream as cumulative listening
        // crosses this track's duration-scaled thresholds.
        if (canCount && dur > 0) {
          const delta = pos - lastPosMs;
          if (delta > 0 && delta < 1500) {
            // Daily music badge: accrue this genuine forward delta (across all
            // posts, independent of the per-post stream window) and flush in chunks.
            // ONLY counts OTHER creators' songs (badgeEligibleRef — no self-loop
            // farming), and at most BADGE_SONG_CAP_MS per song (badgeSongMsRef), so
            // looping one track past 10 min stops adding to badge progress until a
            // different song plays.
            if (badgeEligibleRef.current && badgeSongMsRef.current < BADGE_SONG_CAP_MS) {
              const credit = Math.min(delta, BADGE_SONG_CAP_MS - badgeSongMsRef.current);
              badgeSongMsRef.current += credit;
              badgeMsRef.current += credit;
              if (badgeMsRef.current >= 15000) flushBadgeMs();
            }
            // Audio-ad clock: only while a playlist is armed and no ad is mid-
            // play. Crossing the threshold marks an ad DUE — it does NOT fire
            // here (ads never interrupt a song mid-play). The track-finished
            // path plays the due ad between songs.
            if (adArmedRef.current && !adPlayingRef.current) {
              adListenMsRef.current += delta;
              if (adListenMsRef.current >= adNextThresholdRef.current) adDueRef.current = true;
            }
            const id = track.id;
            // Reset a post's accounting once its 24h window elapses so a genuine
            // listener can earn again the next day (mirrors the server cap window).
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
              recordStream();
              saveProgress();
            } else if (awarded === 1 && listened >= t2 * 1000) {
              streamsAwardedRef.current[id] = 2;
              recordStream();
              saveProgress();
            } else if (awarded === 2 && listened >= t3 * 1000) {
              // 3rd stream — credited by the server only for accounts >24h old.
              streamsAwardedRef.current[id] = 3;
              recordStream();
              saveProgress();
            }
          }
        }
        lastPosMs = pos;

        if (status.didJustFinish) {
          saveProgress();
          flushBadgeMs();
          handleTrackFinished();
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
    <AudioContext.Provider value={{ currentTrack, isPlaying, isBuffering, play, playQueue, setCommentComposing, noteCommentEngagement, clearCommentEngagement, pause, resume, stop, seekTo, expanded, expand, collapse, next, previous, queueIndex, queueLength, videoMuted, toggleVideoMuted, adState, skipAudioAd }}>
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
