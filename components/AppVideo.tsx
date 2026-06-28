import { useEffect, useRef, useState } from 'react';
import { Image as ExpoImage } from 'expo-image';
import { View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';

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
  /** When the position reaches this (seconds), loop back to trimStart (or 0). */
  trimEndSec?: number | null;
  /** Progress cadence in ms (timeUpdate interval). Default 250. */
  progressIntervalMs?: number;
  /** currentTimeMs/durationMs (converted from expo-video's seconds). */
  onProgress?: (currentTimeMs: number, durationMs: number) => void;
  onEnd?: () => void;
};

export default function AppVideo({
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
  trimEndSec,
  progressIntervalMs = 250,
  onProgress,
  onEnd,
}: AppVideoProps) {
  const uri = typeof source === 'string' ? source : source.uri;
  // timeUpdate is only needed for progress reporting or trim looping; leave it at
  // 0 (disabled) otherwise so decorative videos don't emit events every frame-tick.
  const needsTime = !!onProgress || trimEndSec != null;
  const intervalSec = needsTime ? Math.max(0.05, progressIntervalMs / 1000) : 0;

  // Latest callbacks/trim points read inside the (once-subscribed) listeners.
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  const trimStartRef = useRef<number | null>(trimStartSec ?? null);
  trimStartRef.current = trimStartSec ?? null;
  const trimEndRef = useRef<number | null>(trimEndSec ?? null);
  trimEndRef.current = trimEndSec ?? null;
  // Seed the trim-start seek only once per loaded source.
  const seededRef = useRef(false);

  const [showPoster, setShowPoster] = useState(!!poster);

  const player = useVideoPlayer({ uri }, (p) => {
    p.loop = loop;
    p.muted = muted;
    p.timeUpdateEventInterval = intervalSec;
    if (active) p.play();
  });

  // Keep mutable player props in sync with React props.
  useEffect(() => { player.muted = muted; }, [muted, player]);
  useEffect(() => { player.loop = loop; }, [loop, player]);
  useEffect(() => { player.timeUpdateEventInterval = intervalSec; }, [intervalSec, player]);
  useEffect(() => {
    if (active) player.play();
    else player.pause();
  }, [active, player]);

  // useVideoPlayer recreates (and releases) the player whenever the source uri
  // changes, so a new uri means a new `player` here — this effect re-runs, the
  // old listeners are torn down, and we re-seed trim/poster for the new source.
  useEffect(() => {
    seededRef.current = false;
    setShowPoster(!!poster);
    const statusSub = player.addListener('statusChange', ({ status }: any) => {
      if (status === 'readyToPlay') {
        setShowPoster(false);
        if (!seededRef.current) {
          seededRef.current = true;
          const ts = trimStartRef.current;
          if (ts != null && ts > 0) { try { player.currentTime = ts; } catch {} }
        }
      }
    });
    const timeSub = player.addListener('timeUpdate', ({ currentTime }: any) => {
      const dur = player.duration || 0;
      onProgressRef.current?.(currentTime * 1000, dur * 1000);
      const te = trimEndRef.current;
      if (te != null && currentTime >= te) {
        try { player.currentTime = trimStartRef.current ?? 0; } catch {}
      }
    });
    const endSub = player.addListener('playToEnd', () => { onEndRef.current?.(); });
    return () => { statusSub.remove(); timeSub.remove(); endSub.remove(); };
  }, [player]);

  return (
    <View style={style}>
      <VideoView
        style={StyleSheet.absoluteFill}
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
}
