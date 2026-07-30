import { useEffect, useRef } from 'react';
import { View, Animated, Easing, StyleSheet, AccessibilityInfo, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

// The Laybell bell: the logo's shape — a bell whose clapper is a musical note —
// built from two icons rather than an SVG path, because react-native-svg is a
// NATIVE module and adding one for a decorative header icon would cost a
// rebuild and invalidate every dev client in circulation.
//
// When there are unread notifications the note swings and strikes the inside of
// the bell, flashing the brand colour on each hit. It does not fire the instant
// you land — it waits, then rings occasionally, so it reads as the app being
// alive rather than as something demanding attention.
//
// ── Why this is cheap ───────────────────────────────────────────────────────
// Every animated property here (rotate, opacity) runs on the NATIVE driver, so
// the whole thing is handed to the UI thread once and never touches JS again
// while it plays. Animated.Value changes don't re-render, so the host screen —
// the home feed — renders exactly as often as it would without this.
//
// It also does nothing at all unless it is both FOCUSED and UNREAD: leaving the
// tab cancels the loop and clears the timer, so a backgrounded feed isn't
// holding a repeating animation open.

// How far the note travels each way, in degrees. Small on purpose: a clapper
// pivots, it doesn't cartwheel.
const SWING_DEG = 15;

// The first ring waits, so landing on Home isn't greeted by movement.
const FIRST_DELAY_MS = 2400;
// Then rings land somewhere in this window, re-rolled each time. A fixed
// interval reads as a machine; a jittered one reads as incidental.
const GAP_MIN_MS = 17_000;
const GAP_MAX_MS = 33_000;

export default function LaybellBell({ size = 28, color, accent = '#F26522', active, style }: {
  size?: number;
  color: string;
  /** Colour flashed at the moment the note strikes the bell. Defaults to the
   *  brand orange rather than the theme's `error` red: this marks "something is
   *  waiting", not "something went wrong", and the badge beside it already owns
   *  the alarm colour. */
  accent?: string;
  /** True when unread notifications exist AND the screen is focused. */
  active: boolean;
  style?: ViewStyle;
}) {
  const swing = useRef(new Animated.Value(0)).current;   // -1 … 1
  const hit = useRef(new Animated.Value(0)).current;     // red note opacity
  const loop = useRef<Animated.CompositeAnimation | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduceMotion = useRef(false);

  // Respect the OS "Reduce Motion" setting. Someone who has asked the system to
  // stop animating things should not be an exception because this one is
  // pretty.
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => { if (alive) reduceMotion.current = on; })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (on) => {
      reduceMotion.current = on;
    });
    return () => { alive = false; sub?.remove?.(); };
  }, []);

  useEffect(() => {
    if (!active) return;

    // One ring: strike right, strike left, a smaller right, then settle. The
    // flash is parallel to each strike so the colour lands ON the impact rather
    // than after it.
    const strike = (to: number, ms: number) =>
      Animated.parallel([
        Animated.timing(swing, {
          toValue: to,
          duration: ms,
          easing: Easing.out(Easing.quad),   // fast into the wall, like a real clapper
          useNativeDriver: true,
        }),
        Animated.sequence([
          Animated.timing(hit, { toValue: 1, duration: Math.round(ms * 0.7), easing: Easing.in(Easing.quad), useNativeDriver: true }),
          Animated.timing(hit, { toValue: 0, duration: 260, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        ]),
      ]);

    function ring() {
      if (reduceMotion.current) { schedule(); return; }
      loop.current = Animated.sequence([
        strike(1, 150),
        strike(-1, 220),
        strike(0.55, 200),
        Animated.timing(swing, { toValue: 0, duration: 300, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]);
      loop.current.start(({ finished }) => { if (finished) schedule(); });
    }

    function schedule() {
      const gap = GAP_MIN_MS + Math.random() * (GAP_MAX_MS - GAP_MIN_MS);
      timer.current = setTimeout(ring, gap);
    }

    timer.current = setTimeout(ring, FIRST_DELAY_MS);

    return () => {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      loop.current?.stop();
      loop.current = null;
      // Reset so the icon is never left mid-swing or mid-flash when the tab is
      // re-entered, or when the last notification is read.
      swing.setValue(0);
      hit.setValue(0);
    };
  }, [active, swing, hit]);

  const rotate = swing.interpolate({
    inputRange: [-1, 1],
    outputRange: [`-${SWING_DEG}deg`, `${SWING_DEG}deg`],
  });

  // Geometry. The note sits low inside the bell's mouth and is ~45% of the
  // bell's size, which is roughly the proportion in the logo.
  const noteSize = Math.round(size * 0.46);
  const pivot = noteSize * 0.5;

  return (
    <View style={[{ width: size, height: size }, styles.wrap, style]}>
      <Ionicons name="notifications-outline" size={size} color={color} />

      {/* The clapper. Absolutely positioned so it can swing without affecting
          the bell's layout, and pointerEvents none so the parent button keeps
          the whole hit area. */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.note,
          {
            width: noteSize,
            height: noteSize,
            // Pivot from the TOP of the note, not its centre: a clapper hangs.
            // React Native rotates about the centre, so translate up, rotate,
            // translate back.
            transform: [
              { translateY: -pivot },
              { rotate },
              { translateY: pivot },
            ],
          },
        ]}
      >
        <Ionicons name="musical-note" size={noteSize} color={color} />
        {/* The same note in brand colour, faded in at the instant of impact.
            Cross-fading two glyphs keeps this on the native driver — animating
            a colour directly would force the JS driver and put this work back
            on the thread that renders the feed. */}
        <Animated.View style={[StyleSheet.absoluteFill, styles.center, { opacity: hit }]}>
          <Ionicons name="musical-note" size={noteSize} color={accent} />
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
  note: {
    position: 'absolute',
    // Nudged down into the bell's mouth, where a clapper actually hangs.
    top: '30%',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
