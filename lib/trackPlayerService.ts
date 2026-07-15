import TrackPlayer, { Capability, Event } from 'react-native-track-player';

// Lock-screen / Control Center bridge for the MAIN player (contexts/AudioContext).
// react-native-track-player is the playback engine for main-player songs ONLY —
// ambient post music and audio ads stay on expo-audio and must NEVER surface on
// the lock screen (ambient is also killed on backgrounding; only the main
// player is allowed background playback).
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
};

let handlers: RemoteHandlers | null = null;
export function setRemoteHandlers(h: RemoteHandlers | null) { handlers = h; }

// Registered once from the app entry (index.js); lives for the app's lifetime.
export async function playbackService() {
  TrackPlayer.addEventListener(Event.RemotePlay, () => { try { handlers?.play(); } catch {} });
  TrackPlayer.addEventListener(Event.RemotePause, () => { try { handlers?.pause(); } catch {} });
  TrackPlayer.addEventListener(Event.RemoteNext, () => { try { handlers?.next(); } catch {} });
  TrackPlayer.addEventListener(Event.RemotePrevious, () => { try { handlers?.previous(); } catch {} });
  TrackPlayer.addEventListener(Event.RemoteSeek, (e: any) => { try { handlers?.seekTo(((e?.position ?? 0) as number) * 1000); } catch {} });
}

// Lazy one-time native setup — called on the FIRST main-player play, never at
// app launch (no native player construction on the startup path). Deduped via
// the promise so racing plays share one setup. A genuinely FAILED setup (e.g.
// the first tap raced an interruption) is NOT cached: it retries on the next
// play — a cached failure used to mean audio played all session with NO
// lock-screen card until an app restart.
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
        try {
          await TrackPlayer.updateOptions({
            capabilities: [
              Capability.Play, Capability.Pause,
              Capability.SkipToNext, Capability.SkipToPrevious,
              Capability.SeekTo,
            ],
            compactCapabilities: [Capability.Play, Capability.Pause, Capability.SkipToNext],
            progressUpdateEventInterval: 0.25, // matches the old expo-audio tick rate
          });
        } catch {}
      }
    })().finally(() => { if (!setupDone) setupPromise = null; });
  }
  return setupPromise;
}
