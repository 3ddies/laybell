import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Image as ExpoImage } from 'expo-image';
import { View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useMediaSuspend } from '../contexts/MediaSuspendContext';

// Shared <Video> replacement built on expo-video (expo-av is deprecated in SDK 54
// and removed in 55). Keeps the familiar prop API the call sites already use so
// migrating is mechanical:
//   • `active`   — autoplay when true / pause when false (was expo-av `shouldPlay`)
//   • `loop`     — was `isLooping`
//   • `muted`    — was `isMuted`
//   • `contentFit` 'cover'|'contain'|'fill' — was `resizeMode` (ResizeMode.COVER…)
//   • `poster`   — image shown until the first frame is ready (was usePoster/posterSource)
//   • `trimStartSec`/`trimEndSec` — seek to start on load and loop back at the end
//     point (replaces the old onLoad→setPositionAsync + status-driven re-seek that
//     reel/post/grid did imperatively through a ref)
//   • `onProgress(currentTimeMs, durationMs)` — periodic progress. expo-video reports
//     SECONDS; we convert to ms at the event boundary so existing ms-based callers
//     (trackVideoProgress, the story progress bar) are unchanged.
//   • `onEnd` — fired once when the clip plays to its end.
// useVideoPlayer auto-releases the player on unmount, so there's no manual cleanup.

type ContentFit = 'cover' | 'contain' | 'fill';

// Cap on load-error retries per source. With the backoff below (~1.5–5s steps)
// this spans a few minutes — enough to cover a Cloudflare clip's encode window —
// then gives up so a genuinely broken URL doesn't retry forever.
const MAX_LOAD_RETRIES = 45;

export type AppVideoProps = {
  source: string | { uri: string };
  style?: StyleProp<ViewStyle>;
  contentFit?: ContentFit;
  /** Autoplay when true, pause when false. Default true. */
  active?: boolean;
  loop?: boolean;
  muted?: boolean;
  /** Show the OS video controls. Default false. */
  nativeControls?: boolean;
  /** Image shown over the video until the first frame is ready. */
  poster?: string | null;
  posterContentFit?: ContentFit;
  /** Seek here (seconds) once loaded, and the point looped back to at trimEnd. */
  trimStartSec?: number | null;
  /** Seek here (seconds) once loaded when no trim start is set — used to resume a
   *  clip near where another player left off (e.g. rotating a reel to fullscreen). */
  startPositionSec?: number | null;
  /** When the position reaches this (seconds), loop back to trimStart (or 0). */
  trimEndSec?: number | null;
  /** Progress cadence in ms (timeUpdate interval). Default 250. */
  progressIntervalMs?: number;
  /** currentTimeMs/durationMs (converted from expo-video's seconds). */
  onProgress?: (currentTimeMs: number, durationMs: number) => void;
  onEnd?: () => void;
  /** Fires ONCE when the player reaches readyToPlay — i.e. the first frame can
   *  actually paint. Lets a parent hold a placeholder until real content shows. */
  onReady?: () => void;
  /** Keep playing even when a full-screen UI has globally suspended media. */
  ignoreSuspend?: boolean;
};

/** Imperative handle for scrubbing/seeking from a parent (e.g. a progress bar). */
export type AppVideoHandle = { seek: (sec: number) => void };

const AppVideo = forwardRef<AppVideoHandle, AppVideoProps>(function AppVideo({
  source,
  style,
  contentFit = 'cover',
  active = true,
  loop = false,
  muted = false,
  nativeControls = false,
  poster,
  posterContentFit,
  trimStartSec,
  startPositionSec,
  trimEndSec,
  progressIntervalMs = 250,
  onProgress,
  onEnd,
  onReady,
  ignoreSuspend = false,
}: AppVideoProps, ref) {
  const uri = typeof source === 'string' ? source : source.uri;
  // A full-screen takeover (e.g. the GIF maker) can globally pause background
  // videos so their audio doesn't bleed through. Opt out with `ignoreSuspend`.
  const { suspended } = useMediaSuspend();
  const shouldPlay = active && !(suspended && !ignoreSuspend);
  // timeUpdate is only needed for progress reporting or trim looping; leave it at
  // 0 (disabled) otherwise so decorative videos don't emit events every frame-tick.
  const needsTime = !!onProgress || trimEndSec != null;
  const intervalSec = needsTime ? Math.max(0.05, progressIntervalMs / 1000) : 0;

  // Latest callbacks/trim points read inside the (once-subscribed) listeners.
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  // Read the live "should be playing" flag inside listeners (the effect that
  // subscribes runs once per source, so a plain closure would go stale).
  const shouldPlayRef = useRef(shouldPlay);
  shouldPlayRef.current = shouldPlay;
  // Count load-error retries per source (see the statusChange handler).
  const retriesRef = useRef(0);
  // True once the source has reached readyToPlay at least once. After that, a
  // transient 'error' must NOT force a full reload — see the statusChange handler.
  const hasLoadedRef = useRef(false);
  // Guards the trim-end loop seek so it fires once per cycle, not once per
  // timeUpdate tick while the playhead sits past the trim point (a seek storm).
  const trimSeekingRef = useRef(false);
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  // onReady fires once per source (first readyToPlay), not on every re-buffer.
  const firedReadyRef = useRef(false);
  const trimStartRef = useRef<number | null>(trimStartSec ?? null);
  trimStartRef.current = trimStartSec ?? null;
  const startPositionRef = useRef<number | null>(startPositionSec ?? null);
  startPositionRef.current = startPositionSec ?? null;
  const trimEndRef = useRef<number | null>(trimEndSec ?? null);
  trimEndRef.current = trimEndSec ?? null;
  // Seed the trim-start seek only once per loaded source.
  const seededRef = useRef(false);

  // The poster (still) shows until the player reports its first ready frame,
  // mirroring expo-av's usePoster. Kept deliberately simple.
  const [showPoster, setShowPoster] = useState(!!poster);
  // Anti-black-flash: the native video surface renders BLACK from the moment
  // it mounts until the first frame — a visible flash over whatever thumbnail
  // sits beneath (the poster overlay needs its own decode, so it can't cover
  // frame 1). Keep the surface transparent until readyToPlay: the still
  // beneath simply becomes motion.
  const [surfaceReady, setSurfaceReady] = useState(false);

  const player = useVideoPlayer({ uri }, (p) => {
    p.loop = loop;
    p.muted = muted;
    p.timeUpdateEventInterval = intervalSec;
    // Bounded forward buffer (same cap as the pools): unbounded raw-MP4
    // buffering is how one player starves another's stream mid-watch.
    try { (p as any).bufferOptions = { preferredForwardBufferDuration: 8 }; } catch {}
    if (shouldPlay) p.play();
  });

  // Let a parent scrub/seek the playhead (used by the reel progress bar).
  useImperativeHandle(ref, () => ({
    seek: (sec: number) => { try { player.currentTime = Math.max(0, sec); } catch {} },
  }), [player]);

  // Keep mutable player props in sync with React props.
  useEffect(() => { player.muted = muted; }, [muted, player]);
  useEffect(() => { player.loop = loop; }, [loop, player]);
  useEffect(() => { player.timeUpdateEventInterval = intervalSec; }, [intervalSec, player]);
  useEffect(() => {
    if (shouldPlay) { try { player.play(); } catch {} }
    else { try { player.pause(); } catch {} }
  }, [shouldPlay, player]);

  // When the trim window itself changes (e.g. the GIF maker's scrubber moves the
  // start/end live), snap to the new start if the playhead is now outside the
  // window — so the preview loops the new selection immediately. For callers with
  // a fixed trim window this runs once (redundant with the seed) and is harmless.
  useEffect(() => {
    if (trimStartSec == null) return;
    try {
      const ct = player.currentTime;
      if (ct < trimStartSec || (trimEndSec != null && ct > trimEndSec)) player.currentTime = trimStartSec;
    } catch { /* player not ready */ }
  }, [trimStartSec, trimEndSec, player]);

  // useVideoPlayer recreates (and releases) the player whenever the source uri
  // changes, so a new uri means a new `player` here — this effect re-runs, the
  // old listeners are torn down, and we re-seed trim/poster for the new source.
  useEffect(() => {
    seededRef.current = false;
    retriesRef.current = 0;
    hasLoadedRef.current = false;
    trimSeekingRef.current = false;
    firedReadyRef.current = false;
    setShowPoster(!!poster);
    setSurfaceReady(false);
    const statusSub = player.addListener('statusChange', ({ status }: any) => {
      if (status === 'readyToPlay') {
        retriesRef.current = 0;
        hasLoadedRef.current = true;
        setSurfaceReady(true);
        setShowPoster(false);
        if (!firedReadyRef.current) { firedReadyRef.current = true; onReadyRef.current?.(); }
        if (!seededRef.current) {
          seededRef.current = true;
          const ts = trimStartRef.current;
          const seekTo = ts != null && ts > 0 ? ts : startPositionRef.current;
          if (seekTo != null && seekTo > 0) { try { player.currentTime = seekTo; } catch {} }
        }
        // A load can succeed via the error-retry below (e.g. a freshly-posted
        // Cloudflare clip that just finished encoding). The shouldPlay effect
        // won't re-fire on its own, so kick playback here if it should be running.
        if (shouldPlayRef.current) { try { player.play(); } catch {} }
      } else if (status === 'error') {
        // Only force a reload for a source that has NEVER loaded: a just-posted
        // Cloudflare clip is briefly un-decodable while it finishes encoding (the
        // manifest 404s), and without this it would sit on the poster forever.
        //
        // Once a clip HAS played, a transient error (a loop-boundary blip, a brief
        // network drop, an HLS segment hiccup) must NOT trigger replace(): a full
        // reload flashes the poster and re-buffers, which reads as a freeze —
        // the error resets nothing, so it would reload endlessly. A loaded clip
        // recovers on its own, so leave it be.
        if (!hasLoadedRef.current && retriesRef.current < MAX_LOAD_RETRIES) {
          retriesRef.current += 1;
          const delay = Math.min(5000, 1500 + retriesRef.current * 400);
          setTimeout(() => { try { player.replace({ uri }); } catch {} }, delay);
        }
      }
    });
    const timeSub = player.addListener('timeUpdate', ({ currentTime }: any) => {
      const dur = player.duration || 0;
      onProgressRef.current?.(currentTime * 1000, dur * 1000);
      const te = trimEndRef.current;
      if (te != null) {
        // Loop back to the trim start once per cycle. The guard stops the coarse
        // (~4×/s) timeUpdate from firing a fresh seek on every tick while the
        // playhead is still past the trim point but the seek hasn't landed —
        // that seek storm is itself a stutter. Re-arm once the playhead returns.
        if (currentTime >= te && !trimSeekingRef.current) {
          trimSeekingRef.current = true;
          try { player.currentTime = trimStartRef.current ?? 0; } catch {}
        } else if (trimSeekingRef.current && currentTime < te - 0.3) {
          trimSeekingRef.current = false;
        }
      }
    });
    const endSub = player.addListener('playToEnd', () => { onEndRef.current?.(); });
    return () => { statusSub.remove(); timeSub.remove(); endSub.remove(); };
  }, [player]);

  return (
    <View style={style}>
      <VideoView
        style={[StyleSheet.absoluteFill, !surfaceReady && styles.hiddenSurface]}
        player={player}
        contentFit={contentFit}
        nativeControls={nativeControls}
        // iOS 16+ defaults this to true, which floats a "Live Text" scan button
        // over any frame where it detects text/subjects (seen on the muted grid
        // autoplay tiles). We don't use it — turn it off so the grid stays clean.
        allowsVideoFrameAnalysis={false}
      />
      {/* Poster overlay (expo-video has no built-in poster): the still frame shows
          until the player reports readyToPlay, mirroring expo-av's usePoster.
          pointerEvents none so taps still reach the parent (open post / reel). */}
      {showPoster && poster ? (
        <ExpoImage
          source={{ uri: poster }}
          style={StyleSheet.absoluteFill}
          contentFit={posterContentFit ?? contentFit}
          pointerEvents="none"
        />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({ hiddenSurface: { opacity: 0 } });

export default AppVideo;
