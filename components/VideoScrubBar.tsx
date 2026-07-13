import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import {
  Animated, View, StyleSheet, PanResponder, Easing, type StyleProp, type ViewStyle,
} from 'react-native';

// A thin white progress bar for the reel player. Progress is pushed in
// imperatively via the ref (`setProgress`) so the video's time-updates re-render
// only this tiny bar, never the whole reel screen. The fill is driven by an
// Animated.Value that GLIDES linearly to each new sample over the gap between
// updates — so it slides smoothly instead of ticking once per update. Tapping or
// dragging anywhere along the bar seeks the video (onSeek receives SECONDS).
export type VideoScrubBarHandle = { setProgress: (posMs: number, durMs: number) => void };

type Props = {
  /** Seek target in seconds (fraction × duration). */
  onSeek: (sec: number) => void;
  /** Fired true while a drag/tap is in progress, false on release. */
  onScrubbingChange?: (scrubbing: boolean) => void;
  /** Distance of the visible line from the screen bottom (usually safe-area + a bit). */
  bottomInset?: number;
  /** Grabbable height above the visible line. Larger = bigger bottom touch zone. */
  reachAbove?: number;
  style?: StyleProp<ViewStyle>;
};

// Default grabbable space ABOVE the visible line, so users don't have to hit the
// thin line exactly. The whole band BELOW the line (down to the screen edge) is
// grabbable too — the touch area is anchored to the bottom.
const DEFAULT_REACH_ABOVE = 12;

export default forwardRef<VideoScrubBarHandle, Props>(function VideoScrubBar(
  { onSeek, onScrubbingChange, bottomInset = 0, reachAbove = DEFAULT_REACH_ABOVE, style }, ref,
) {
  // 0..1 fill fraction, animated so it interpolates between discrete samples.
  const anim = useRef(new Animated.Value(0)).current;
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const widthRef = useRef(1);
  const durRef = useRef(0);        // ms
  const lastTsRef = useRef(0);     // wall-clock of the previous sample

  useImperativeHandle(ref, () => ({
    setProgress: (posMs: number, durMs: number) => {
      if (durMs > 0) durRef.current = durMs;
      if (draggingRef.current || durRef.current <= 0) return;
      const frac = Math.max(0, Math.min(1, posMs / durRef.current));
      const now = Date.now();
      const dt = lastTsRef.current ? now - lastTsRef.current : 300;
      lastTsRef.current = now;
      // Glide to the new sample over ~the gap since the last one (clamped), so a
      // 1s-apart update slides continuously rather than snapping.
      Animated.timing(anim, {
        toValue: frac,
        duration: Math.min(1200, Math.max(120, dt)),
        easing: Easing.linear,
        // Native-driven scaleX: the glide runs continuously for the entire reel
        // playback — JS-driven it stalled exactly when the JS thread hitched.
        useNativeDriver: true,
      }).start();
    },
  }), [anim]);

  // Local x where the touch first landed on the bar; the live x is this plus the
  // gesture's accumulated dx (reliable for both taps, where dx≈0, and drags —
  // unlike per-move locationX, which jumps around).
  const grantXRef = useRef(0);
  const applyLocalX = (localX: number) => {
    const f = Math.max(0, Math.min(1, localX / (widthRef.current || 1)));
    anim.stopAnimation();
    anim.setValue(f);
    return f;
  };
  const endScrub = () => { draggingRef.current = false; setDragging(false); onScrubbingChange?.(false); };

  const pan = useRef(
    PanResponder.create({
      // Claim the touch the instant it lands in the bar…
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      // …and REFUSE to hand it to the parent pager / swipe-to-dismiss, so a drag
      // here never leaks out as a sideways page swipe.
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: (e) => {
        draggingRef.current = true; setDragging(true); onScrubbingChange?.(true);
        grantXRef.current = e.nativeEvent.locationX;
        applyLocalX(grantXRef.current);
      },
      onPanResponderMove: (_e, gs) => { applyLocalX(grantXRef.current + gs.dx); },
      onPanResponderRelease: (_e, gs) => {
        const f = applyLocalX(grantXRef.current + gs.dx);
        onSeek((durRef.current / 1000) * f);
        lastTsRef.current = 0; // next sample restarts the glide cleanly
        endScrub();
      },
      onPanResponderTerminate: endScrub,
    }),
  ).current;

  // Native-driven fill: full-width bar scaled from its left edge (solid color,
  // so the scale reads as the identical left-anchored reveal). The knob (drag
  // only) rides a translateX over the measured width.
  const knobX = anim.interpolate({ inputRange: [0, 1], outputRange: [0, Math.max(1, widthRef.current)] });

  return (
    <View
      style={[styles.wrap, { height: bottomInset + reachAbove + 6 }, style]}
      hitSlop={{ top: 8, bottom: 0, left: 4, right: 4 }}
      onLayout={(e) => { widthRef.current = e.nativeEvent.layout.width; }}
      {...pan.panHandlers}
    >
      <View style={[styles.track, dragging && styles.trackActive, { bottom: bottomInset }]} pointerEvents="none">
        <Animated.View style={[styles.fill, { transform: [{ scaleX: anim }] }]} />
      </View>
      {dragging && <Animated.View style={[styles.knob, { left: 0, bottom: bottomInset - 5, transform: [{ translateX: knobX }] }]} pointerEvents="none" />}
    </View>
  );
});

const styles = StyleSheet.create({
  // Near-full-width touch target anchored to the screen bottom: the visible line
  // sits `bottomInset` up, and the whole band below it (plus `reachAbove` above)
  // is grabbable so users don't have to hit the thin line exactly.
  wrap: { position: 'absolute', left: 12, right: 12, bottom: 0 },
  track: {
    position: 'absolute', left: 0, right: 0, height: 3, borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.3)', overflow: 'hidden',
  },
  trackActive: { height: 5, borderRadius: 3 },
  fill: { width: '100%', height: '100%', backgroundColor: '#fff', borderRadius: 3, transformOrigin: 'left' },
  knob: {
    position: 'absolute', width: 14, height: 14, borderRadius: 7, marginLeft: -7,
    backgroundColor: '#fff',
  },
});
