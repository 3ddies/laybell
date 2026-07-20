import { View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { useEffect, useRef, useState } from 'react';
import { PinchGestureHandler, PanGestureHandler, State } from 'react-native-gesture-handler';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { RADIUS } from '../constants/theme';
import { useTheme } from '../contexts/ThemeContext';

// Filmstrip trim bar for the GIF maker: a row of frames (the "render bar") with a
// selection window drawn on it. The WHOLE bar is interactive — DRAG (1 finger)
// anywhere to move where the GIF starts, PINCH (2 fingers) anywhere to grow/shrink
// the duration (around the window centre), clamped to [minDur, maxDur]. The window
// + edge grips are visual only. Reports (startSec, durSec) live.
const FRAMES = 8;

export default function GifTrimBar({
  uri, frameUrlAt, duration, minDur, maxDur, width, height = 64, initialStart = 0, initialDur, onChange,
}: {
  uri: string;
  // Cloudflare Stream: a per-time frame URL (HLS can't be frame-grabbed on-device),
  // used directly as the thumbnail source instead of expo-video-thumbnails.
  frameUrlAt?: ((timeSec: number) => string | null) | null;
  duration: number;
  minDur: number;
  maxDur: number;
  width: number;
  height?: number;
  initialStart?: number;
  initialDur?: number;
  onChange: (startSec: number, durSec: number) => void;
}) {
  const { colors } = useTheme();
  const pxPerSec = width / (duration || 1);

  const [start, setStart] = useState(initialStart);
  const [durS, setDurS] = useState(Math.min(initialDur ?? maxDur, duration));
  const [frames, setFrames] = useState<string[]>([]);

  const startRef = useRef(start); startRef.current = start;
  const durRef = useRef(durS); durRef.current = durS;
  // Values captured at the start of a gesture.
  const gStart = useRef(0);
  const gDur = useRef(0);
  const gCenter = useRef(0);
  const pinchRef = useRef<any>(null);
  const panRef = useRef<any>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const out: string[] = new Array(FRAMES).fill('');
      for (let i = 0; i < FRAMES; i++) {
        const at = (duration * (i + 0.5)) / FRAMES;
        try {
          // CF Stream: use the frame URL directly (the <Image> loads it). Local
          // mp4: extract with expo-video-thumbnails.
          if (frameUrlAt) {
            out[i] = frameUrlAt(at) ?? '';
          } else {
            const r = await VideoThumbnails.getThumbnailAsync(uri, { time: Math.floor(at * 1000), quality: 0.3 });
            if (r?.uri) out[i] = r.uri;
          }
        } catch { /* leave blank */ }
        if (!active) return;
        setFrames([...out]);
      }
    })();
    return () => { active = false; };
  }, [uri, duration, frameUrlAt]);

  // DRAG anywhere → move the window (duration fixed).
  function onPanEvent(e: any) {
    let s = gStart.current + e.nativeEvent.translationX / pxPerSec;
    s = Math.max(0, Math.min(duration - durRef.current, s));
    setStart(s); onChange(s, durRef.current);
  }
  function onPanState(e: any) {
    if (e.nativeEvent.state === State.BEGAN) gStart.current = startRef.current;
  }
  // PINCH anywhere → resize duration around the window centre.
  function onPinchEvent(e: any) {
    const d = Math.max(minDur, Math.min(maxDur, gDur.current * e.nativeEvent.scale));
    const s = Math.max(0, Math.min(duration - d, gCenter.current - d / 2));
    setStart(s); setDurS(d); onChange(s, d);
  }
  function onPinchState(e: any) {
    if (e.nativeEvent.state === State.BEGAN) {
      gDur.current = durRef.current;
      gStart.current = startRef.current;
      gCenter.current = startRef.current + durRef.current / 2;
    }
  }

  const leftX = start * pxPerSec;
  const winW = durS * pxPerSec;

  return (
    <PinchGestureHandler ref={pinchRef} simultaneousHandlers={panRef} onGestureEvent={onPinchEvent} onHandlerStateChange={onPinchState}>
      <PanGestureHandler ref={panRef} simultaneousHandlers={pinchRef} maxPointers={1} onGestureEvent={onPanEvent} onHandlerStateChange={onPanState}>
        <View style={[styles.track, { width, height, borderRadius: RADIUS.md, backgroundColor: colors.surfaceLight }]}>
          {/* Filmstrip */}
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.strip]}>
            {Array.from({ length: FRAMES }).map((_, i) => (
              frames[i]
                ? <Image key={i} source={{ uri: frames[i] }} style={{ width: width / FRAMES, height }} contentFit="cover" />
                : <View key={i} style={{ width: width / FRAMES, height, backgroundColor: colors.surface }} />
            ))}
          </View>

          {/* Dim outside the selection */}
          <View pointerEvents="none" style={[styles.dim, { left: 0, width: leftX, height }]} />
          <View pointerEvents="none" style={[styles.dim, { left: leftX + winW, width: Math.max(0, width - leftX - winW), height }]} />

          {/* Selection window + edge grips (visual only) */}
          <View pointerEvents="none" style={[styles.window, { left: leftX, width: winW, height, borderColor: colors.primary }]} />
          <View pointerEvents="none" style={[styles.grip, { left: leftX + 3, backgroundColor: colors.primary }]} />
          <View pointerEvents="none" style={[styles.grip, { left: leftX + winW - 6, backgroundColor: colors.primary }]} />
        </View>
      </PanGestureHandler>
    </PinchGestureHandler>
  );
}

const styles = StyleSheet.create({
  track: { overflow: 'hidden', justifyContent: 'center' },
  strip: { flexDirection: 'row' },
  dim: { position: 'absolute', top: 0, backgroundColor: 'rgba(0,0,0,0.55)' },
  window: { position: 'absolute', top: 0, borderWidth: 3, borderRadius: RADIUS.md, backgroundColor: 'transparent' },
  grip: { position: 'absolute', top: '50%', marginTop: -9, width: 3, height: 18, borderRadius: 2 },
});
