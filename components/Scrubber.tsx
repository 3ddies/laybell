import { View, StyleSheet, PanResponder, Animated } from 'react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';

const clamp = (n: number) => Math.max(0, Math.min(1, n));

// Sample a multi-stop ramp at t (0..1) and return one solid colour.
//
// The thumb used to paint the WHOLE gradient into its 14pt disc, which looked
// the same at 3 seconds as at three minutes — pretty, but it told you nothing.
// Sampling means the thumb is the exact colour the bar has reached underneath
// it: white at the start, brand-deep by the end, and genuinely mid-ramp in
// between. The circle becomes a readout rather than a decoration.
const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
function sampleRamp(stops: readonly string[], t: number): string {
  const p = clamp(t) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(p));
  const f = p - i;
  const a = hex(stops[i]);
  const b = hex(stops[i + 1]);
  const mix = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
}

// A draggable progress scrubber. Uses absolute pageX vs the bar's measured
// window position, and an Animated value so playback glides smoothly between
// status updates and dragging doesn't re-render the parent.
//
// NATIVE-DRIVEN: playback retargets this animation ~4×/s for as long as any
// music plays, and the bar rides in the MiniPlayer on every screen — as a
// JS-driven width animation it was a continuous JS-thread layout pass
// app-wide. Instead, the fill is a mask/gradient pair moved by OPPOSITE
// translateX transforms: the clipping mask slides left to hide, while the
// gradient counter-slides so it stays fixed in track space. Pixel-identical
// to the old width reveal, but it runs entirely on the native driver.
export default function Scrubber({
  progress, onSeek, height = 20, trackHeight = 4, thumbSize = 14, disabled = false,
}: {
  progress: number;            // 0..1
  onSeek: (ratio: number) => void;
  height?: number; trackHeight?: number; thumbSize?: number;
  // Read-only: still shows the progress fill but can't be dragged (and hides the
  // thumb). Used for ads on the TV remote — a sponsor can't be scrubbed.
  disabled?: boolean;
}) {
  const { colors, mode } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const isLight = mode === 'light';

  // The fill stays a GRADIENT in both themes — the owner asked for the progress
  // effect to survive, only its colour to change. Light keeps the brand warm
  // ramp; dark gets a white one.
  //
  // Dark runs WHITE → PALE YELLOW → BRIGHT YELLOW. Two earlier attempts landed
  // wrong in the same direction: ending on the brand red (#E8401C) was too loud,
  // and darkening it to amber (#C97F08) only turned it mustard. Both were adding
  // BLACK to the yellow, when what the bar wants is the opposite.
  //
  // So this ramp holds red at maximum the whole way across and drains only green
  // and blue — white (255,255,255) → (255,235,150) → (255,214,45). Every stop is
  // a bright, light yellow, and the bar gets warmer by getting more saturated
  // rather than by getting darker. That is why it never reads as orange.
  // Light keeps the brand warm ramp; white at the start would be near-invisible
  // on a pale track.
  const fillStops = (isLight
    ? GRADIENTS.primaryWarm
    : ['#FFFFFF', '#FFEB96', '#FFD62D']) as readonly [string, string, ...string[]];

  // The ring is the PAGE colour in both themes, which is not the obvious choice
  // and is the only one that survives the thumb being sampled.
  //
  // Now that the thumb takes its colour from its own position on the ramp, it is
  // by definition close to the fill directly behind it — white on white at the
  // start, deep orange on deep orange at the end. Any fixed ring colour is
  // therefore invisible at one end or the other: white vanishes at 0%, orange
  // vanishes at 100%. colors.background belongs to neither end of the ramp, so it
  // reads as a thin cut-out around the disc wherever the disc happens to be.
  const thumbRing = colors.background;
  const [width, setWidth] = useState(0);
  const ref = useRef<View>(null);
  const layout = useRef({ x: 0, w: 0 });
  const anim = useRef(new Animated.Value(0)).current;
  const dragging = useRef(false);
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  // Post-seek hold: stamped at drag release so stale pre-seek progress ticks
  // (the 4Hz position prop lags the seek by 1-2 ticks) can't flick the fill
  // backward before the seek lands.
  const seekGuard = useRef(0);
  const seekRatio = useRef(0);

  // Position for the THUMB'S COLOUR only.
  //
  // Playback already re-renders this component ~4×/s through the `progress`
  // prop, so sampling from it costs nothing extra. A drag deliberately does NOT
  // re-render (that is the whole point of the Animated value), so it publishes
  // its position here on a 60ms throttle — a handful of tiny re-renders while a
  // finger is actually down, and none at all the rest of the time. Without it
  // the thumb would hold its old colour through the drag and jump on release,
  // which is exactly the "same no matter where you are" problem this fixes.
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const lastPublish = useRef(0);
  const publish = (r: number, force = false) => {
    const now = Date.now();
    if (!force && now - lastPublish.current < 60) return;
    lastPublish.current = now;
    setDragRatio(r);
  };
  const thumbFill = sampleRamp(fillStops, dragRatio ?? clamp(progress));

  // Glide toward the playback position when not actively dragging.
  useEffect(() => {
    if (dragging.current) return;
    const p = clamp(progress);
    // Hold at the release point until the reported position agrees (±2%) or
    // 700ms passes — the fill lands where the finger dropped it and stays.
    if (Date.now() - seekGuard.current < 700 && Math.abs(p - seekRatio.current) >= 0.02) return;
    // Pre-measure (width 0): SEED silently instead of animating, so the bar
    // appears already at position when it first lays out — previously opening
    // NowPlaying mid-song showed the fill visibly gliding in from zero.
    if (width === 0) { anim.setValue(p); return; }
    Animated.timing(anim, { toValue: p, duration: 240, useNativeDriver: true }).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress, width]);

  const measure = () => ref.current?.measureInWindow((x, _y, w) => { layout.current = { x, w }; setWidth(w); });
  const ratioFor = (pageX: number) => clamp((pageX - layout.current.x) / (layout.current.w || 1));

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !disabledRef.current,
      onMoveShouldSetPanResponder: () => !disabledRef.current,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: e => { dragging.current = true; anim.stopAnimation(); const r = ratioFor(e.nativeEvent.pageX); anim.setValue(r); publish(r, true); },
      onPanResponderMove: e => { const r = ratioFor(e.nativeEvent.pageX); anim.setValue(r); publish(r); },
      onPanResponderRelease: e => { const r = ratioFor(e.nativeEvent.pageX); anim.setValue(r); dragging.current = false; seekGuard.current = Date.now(); seekRatio.current = r; setDragRatio(null); onSeekRef.current(r); },
      onPanResponderTerminate: e => { const r = ratioFor(e.nativeEvent.pageX); anim.setValue(r); dragging.current = false; seekGuard.current = Date.now(); seekRatio.current = r; setDragRatio(null); onSeekRef.current(r); },
    })
  ).current;

  // Reveal transforms (see header comment). Memoized per measured width so the
  // per-tick progress re-renders don't rebuild/reattach the interpolations.
  const w = Math.max(1, width);
  const { maskX, gradX, thumbX } = useMemo(() => ({
    maskX: anim.interpolate({ inputRange: [0, 1], outputRange: [-w, 0] }),
    gradX: anim.interpolate({ inputRange: [0, 1], outputRange: [w, 0] }),
    thumbX: anim.interpolate({ inputRange: [0, 1], outputRange: [0, Math.max(0, w - thumbSize)] }),
  }), [anim, w, thumbSize]);

  return (
    <View ref={ref} onLayout={measure} style={[styles.area, { height }]} {...pan.panHandlers}>
      <View style={[styles.track, { height: trackHeight, borderRadius: trackHeight / 2 }]}>
        {/* Sliding clip window: its own bounds clip the counter-slid gradient,
            and the track's overflow:hidden clips whatever pokes past the ends. */}
        <Animated.View style={{ width: '100%', height: '100%', overflow: 'hidden', transform: [{ translateX: maskX }] }}>
          <Animated.View style={{ width: '100%', height: '100%', transform: [{ translateX: gradX }] }}>
            {/* Fixed-width gradient held stationary in track space by the counter-slide */}
            <LinearGradient
              colors={fillStops}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
              style={{ width: w, height: '100%' }}
            />
          </Animated.View>
        </Animated.View>
      </View>
      {!disabled && (
        <Animated.View
          style={[styles.thumb, {
            width: thumbSize, height: thumbSize, borderRadius: thumbSize / 2,
            top: (height - thumbSize) / 2, left: 0, transform: [{ translateX: thumbX }],
            borderColor: thumbRing, backgroundColor: thumbFill,
          }]}
        />
      )}
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  area: { width: '100%', justifyContent: 'center' },
  track: { width: '100%', backgroundColor: colors.border, overflow: 'hidden' },
  // Both colours are supplied inline: the fill is SAMPLED from the ramp at the
  // current position and the ring is derived from it, neither of which this
  // palette-only factory can express.
  thumb: { position: 'absolute', borderWidth: 2 },
});
