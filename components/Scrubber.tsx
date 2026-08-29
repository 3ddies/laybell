import { View, StyleSheet, PanResponder, Animated } from 'react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';

const clamp = (n: number) => Math.max(0, Math.min(1, n));

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
  // Dimmer stop first, brightest at the LEADING edge, which mirrors how
  // primaryWarm already runs (#F26522 → the brighter #FAB525). The bright end
  // lands on the playhead, so the bar reads as being lit from where it is up to.
  const fillStops = (isLight ? GRADIENTS.primaryWarm : ['#C6C6CE', '#FFFFFF']) as readonly [string, string];

  // The thumb straddles the boundary between fill and empty track, so its ring
  // has to separate it from BOTH. On light that is the brand orange it always
  // had, against a near-black dot. On dark the dot is white on a now-white fill,
  // so a white ring would let it dissolve into the bar exactly where it matters —
  // the ring goes dark instead.
  const thumbRing = isLight ? colors.primary : colors.background;
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
      onPanResponderGrant: e => { dragging.current = true; anim.stopAnimation(); anim.setValue(ratioFor(e.nativeEvent.pageX)); },
      onPanResponderMove: e => anim.setValue(ratioFor(e.nativeEvent.pageX)),
      onPanResponderRelease: e => { const r = ratioFor(e.nativeEvent.pageX); anim.setValue(r); dragging.current = false; seekGuard.current = Date.now(); seekRatio.current = r; onSeekRef.current(r); },
      onPanResponderTerminate: e => { const r = ratioFor(e.nativeEvent.pageX); anim.setValue(r); dragging.current = false; seekGuard.current = Date.now(); seekRatio.current = r; onSeekRef.current(r); },
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
            borderColor: thumbRing,
          }]}
        />
      )}
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  area: { width: '100%', justifyContent: 'center' },
  track: { width: '100%', backgroundColor: colors.border, overflow: 'hidden' },
  // borderColor is supplied inline (thumbRing) — it is theme-dependent in a
  // way this palette-only factory cannot express.
  thumb: { position: 'absolute', backgroundColor: colors.text, borderWidth: 2 },
});
