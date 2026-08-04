import { Platform } from 'react-native';
import TrackPlayer, { AppKilledPlaybackBehavior, Capability, Event } from 'react-native-track-player';

// Lock-screen / Control Center bridge for the MAIN player (contexts/AudioContext).
// react-native-track-player is the playback ENGINE for main-player songs ONLY —
// ambient post music and audio ads stay on expo-audio (ambient is also killed on
// backgrounding; only the main player is allowed background playback). NOTE: an
// audio AD still plays on expo-audio, but while it runs AudioContext repaints
// this track-player card with the ad's metadata + a live scrubber (see
// pushAdNowPlaying) so a background listener sees the ad on the lock screen
// instead of the frozen paused song. Ambient post music never touches the card.
//
// The playback service (registered from index.js at app entry) receives the
// iOS lock-screen / Control Center remote commands and routes them into
// whatever handlers the AudioProvider registered — so the lock screen drives
// the EXACT same play/pause/next/previous/seek logic as the in-app buttons,
// and the two can never drift out of sync.

export type RemoteHandlers = {
  play: () => void;
  pause: () => void;
  next: () => void;
  previous: () => void;
  seekTo: (ms: number) => void;
  /** The lock-screen heart. iOS only — see the capability note below. */
  like?: () => void;
};

let handlers: RemoteHandlers | null = null;
export function setRemoteHandlers(h: RemoteHandlers | null) { handlers = h; }

// Imperative pause for non-React call sites that must not subscribe to the
// audio context (e.g. the always-mounted story camera pausing music before it
// claims the mic). Same synchronized path as the lock-screen pause command —
// in-app state and the iOS card always agree. Safe no-op when nothing plays.
export function pauseMainPlayer() { try { handlers?.pause(); } catch {} }

// Registered once from the app entry (index.js); lives for the app's lifetime.
//
// EVERY remote command falls back to driving TrackPlayer DIRECTLY when no
// handlers are registered. That is not defensive padding — on Android the
// playback service can run in a headless JS context with the React tree
// unmounted (screen off, app backgrounded, or the app swiped away while
// appKilledPlaybackBehavior keeps audio alive), and `handlers` is set by
// AudioProvider, so it is null exactly then.
//
// Why that was fatal rather than merely inert: react-native-track-player
// configures KotlinAudio with interceptPlayerActionsTriggeredExternally = true,
// so the native player deliberately does NOT act on a notification button — it
// forwards the press to JS and waits. With nothing listening, the press was
// neither handled natively nor in JS, and the media session collapsed: audio
// cut out and the notification vanished (owner-reported on the Samsung, with
// the screen off).
//
// The fallbacks keep the lock-screen transport working headlessly. When the app
// IS mounted, handlers still win, so in-app state and the card stay in sync.
const remote = {
  play: () => { if (handlers) handlers.play(); else TrackPlayer.play().catch(() => {}); },
  pause: () => { if (handlers) handlers.pause(); else TrackPlayer.pause().catch(() => {}); },
  next: () => { if (handlers) handlers.next(); else TrackPlayer.skipToNext().catch(() => {}); },
  previous: () => { if (handlers) handlers.previous(); else TrackPlayer.skipToPrevious().catch(() => {}); },
  seekTo: (ms: number) => {
    if (handlers) handlers.seekTo(ms);
    else TrackPlayer.seekTo(ms / 1000).catch(() => {});
  },
};

export async function playbackService() {
  TrackPlayer.addEventListener(Event.RemotePlay, () => { try { remote.play(); } catch {} });
  TrackPlayer.addEventListener(Event.RemotePause, () => { try { remote.pause(); } catch {} });
  TrackPlayer.addEventListener(Event.RemoteNext, () => { try { remote.next(); } catch {} });
  TrackPlayer.addEventListener(Event.RemotePrevious, () => { try { remote.previous(); } catch {} });
  TrackPlayer.addEventListener(Event.RemoteSeek, (e: any) => { try { remote.seekTo(((e?.position ?? 0) as number) * 1000); } catch {} });
  // The heart. No TrackPlayer fallback like the transport commands have —
  // there's nothing native to fall back TO, and liking needs a signed-in user
  // plus the current post id, which only AudioProvider holds. That's fine here
  // because the button is iOS-only, and iOS keeps the JS tree alive for the
  // whole background-audio session, so `handlers` is registered whenever the
  // card is on screen. (Android's headless-service case, which is why the
  // transport commands need fallbacks, can't reach this command at all.)
  TrackPlayer.addEventListener(Event.RemoteLike, () => { try { handlers?.like?.(); } catch {} });
  // Android's audio-focus loss (a call, another app taking output) arrives here
  // too. Without a listener the service can be torn down instead of pausing.
  TrackPlayer.addEventListener(Event.RemoteDuck, (e: any) => {
    try {
      if (e?.paused || e?.permanent) remote.pause();
      else remote.play();
    } catch {}
  });
}

// Lazy one-time native setup — called on the FIRST main-player play, never at
// app launch (no native player construction on the startup path). Deduped via
// the promise so racing plays share one setup. A genuinely FAILED setup (e.g.
// the first tap raced an interruption) is NOT cached: it retries on the next
// play — a cached failure used to mean audio played all session with NO
// lock-screen card until an app restart.
// The FULL option set, rebuilt on every push. updateOptions REPLACES what it's
// given rather than merging, so sending a lone `likeOptions` to repaint the
// heart would drop the transport capabilities with it and leave the lock screen
// with no play/pause. Keeping one builder makes that impossible.
let likedActive = false;
function playerOptions() {
  return {
    android: {
      // Swiping Laybell out of recents keeps the music + its notification
      // alive (the Spotify behavior). Explicit so a library default change can
      // never silently regress it.
      appKilledPlaybackBehavior: AppKilledPlaybackBehavior.ContinuePlayback,
    },
    capabilities: [
      Capability.Play, Capability.Pause,
      Capability.SkipToNext, Capability.SkipToPrevious,
      Capability.SeekTo,
      // iOS ONLY. Capability.Like maps to MPRemoteCommandCenter's likeCommand —
      // the heart on the lock-screen / Control Center card.
      // react-native-track-player has no Android implementation for it (nothing
      // in its Android source handles the capability), so sending it there
      // would be dead weight in the notification builder rather than a button.
      ...(Platform.OS === 'ios' ? [Capability.Like] : []),
    ],
    compactCapabilities: [Capability.Play, Capability.Pause, Capability.SkipToNext],
    // `title` is the label iOS shows/reads for the command; `isActive` is the
    // filled-vs-outline state. iOS has no "unlike" affordance of its own, so
    // the title carries what the press will DO next.
    likeOptions: { isActive: likedActive, title: likedActive ? 'Unlike' : 'Like' },
    progressUpdateEventInterval: 0.25, // matches the old expo-audio tick rate
  };
}

/**
 * Repaint the lock-screen heart. No-op until the player has been set up, and on
 * Android where the capability isn't sent at all. Cheap enough to call on every
 * track change; skips the bridge hop entirely when the state hasn't moved.
 */
export async function setNowPlayingLiked(active: boolean): Promise<void> {
  if (Platform.OS !== 'ios' || !setupDone || active === likedActive) return;
  likedActive = active;
  try { await TrackPlayer.updateOptions(playerOptions()); } catch {}
}

let setupDone = false;
let setupPromise: Promise<void> | null = null;
export function ensurePlayerSetup(): Promise<void> {
  if (setupDone) return Promise.resolve();
  if (!setupPromise) {
    setupPromise = (async () => {
      try {
        // Phone calls / Siri interruptions auto-pause and auto-resume.
        await TrackPlayer.setupPlayer({ autoHandleInterruptions: true });
        setupDone = true;
      } catch (e: any) {
        // "player already initialized" (Fast Refresh, account switch) = done.
        if (String(e?.message ?? e).toLowerCase().includes('already')) setupDone = true;
      }
      if (setupDone) {
        try { await TrackPlayer.updateOptions(playerOptions()); } catch {}
      }
    })().finally(() => { if (!setupDone) setupPromise = null; });
  }
  return setupPromise;
}
