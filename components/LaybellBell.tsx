import { useEffect, useRef } from 'react';
import { View, Text, Image, Animated, Easing, StyleSheet, AccessibilityInfo, type ViewStyle } from 'react-native';

// The Laybell bell — the actual logo, not an approximation of it.
//
// ── Why an image and not icons or SVG ───────────────────────────────────────
// assets/bell-icon.png is generated from assets/android-icon-monochrome.png,
// the brand logo as a white silhouette in the alpha channel. Every pixel is a
// source pixel: it is cropped to the ink and re-padded square (the Android
// adaptive-icon safe zone left the bell filling only 58% of its canvas, which
// rendered visibly smaller than the icons beside it), never redrawn.
//
// White + alpha is exactly what tintColor wants, so one asset serves every
// theme and the accent flash — tintColor multiplies the colour channels, which
// is why the RGB is forced to pure white.
//
// react-native-svg would allow the note to swing independently of the bell, but
// it is a NATIVE module: adding it costs a rebuild and invalidates every dev
// client in circulation. Measured on the real artwork, the bell and the note
// are a SINGLE connected component — the note's stem crosses the bell's dome —
// so separating them would mean redrawing the logo by hand rather than using
// it. The whole bell rocks instead, which is what a struck bell does anyway.
//
// ── Why this is cheap ───────────────────────────────────────────────────────
// Rotation and opacity both run on the NATIVE driver, so the sequence is handed
// to the UI thread once and never touches JS again while it plays. No component
// state, so the home feed re-renders exactly as often as it did before. It runs
// only while focused AND unread, and tears down its timer and animation on the
// way out.

const BELL = require('../assets/bell-icon.png');

// ── Where the notehead is, measured not guessed ─────────────────────────────
// Found with a distance transform over the artwork's alpha: the largest circle
// that fits inside the mark is the note's head, centred here.
const HEAD_X = 0.463;   // of icon width
const HEAD_Y = 0.723;   // of icon height

// The counter is drawn as an ENLARGED notehead rather than text inside the
// existing one. The real head measures only 19% of the icon's width — about 5pt
// at header size — which cannot legibly hold a digit at any font size. Growing
// it to 40% keeps it unmistakably the note's head (same centre, same colour,
// still on the stem) while leaving room for a readable number.
const HEAD_SCALE = 0.40;
const HEAD_FONT = 0.25;   // of icon size, for a single digit
const HEAD_FONT_2 = 0.20; // slightly tighter for "9+"

// Rock angle. A bell swings from its crown, so this is a modest arc — enough to
// read as motion at 28pt without the icon looking like it came loose.
const SWING_DEG = 13;

// The first ring waits, so landing on Home isn't greeted by movement.
const FIRST_DELAY_MS = 2400;
// Then rings land somewhere in this window, re-rolled each time. A fixed
// interval reads as a machine; a jittered one reads as incidental.
const GAP_MIN_MS = 17_000;
const GAP_MAX_MS = 33_000;

export default function LaybellBell({
  size = 34, color, unreadColor, accent = '#FF8095', count, focused, style,
}: {
  size?: number;
  /** Resting colour when everything has been read. */
  color: string;
  /** Colour the whole mark takes while notifications are unread. This replaces
   *  the old count badge: the bell IS the indicator now, so the state has to be
   *  legible from the mark alone. */
  unreadColor: string;
  /** Flashed at the moment of each strike. Default is a LIFT of the theme's
   *  error red, not a different hue — the bell is already red while unread, so
   *  a red flash would be invisible. A lighter tone reads as the strike
   *  catching the light. */
  accent?: string;
  /** How many are unread. Drawn into the notehead; 0 means nothing is shown. */
  count: number;
  /** Animation runs only while the screen is on. */
  focused: boolean;
  style?: ViewStyle;
}) {
  // Ring only when there is something to ring about and someone to see it.
  const unread = count > 0;
  const active = unread && focused;
  const tint = unread ? unreadColor : color;
  const swing = useRef(new Animated.Value(0)).current;   // -1 … 1
  const hit = useRef(new Animated.Value(0)).current;     // accent layer opacity
  const loop = useRef<Animated.CompositeAnimation | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduceMotion = useRef(false);

  // Respect the OS "Reduce Motion" setting. Someone who asked the system to
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

    // One swing of the bell, with the accent flashed at the far end — the
    // moment the clapper would meet the wall. Easing.out means it arrives fast
    // and stops hard, the way a struck bell does; a linear swing reads as
    // floating.
    const strike = (to: number, ms: number, flash: number) =>
      Animated.parallel([
        Animated.timing(swing, { toValue: to, duration: ms, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.sequence([
          Animated.timing(hit, { toValue: flash, duration: Math.round(ms * 0.75), easing: Easing.in(Easing.quad), useNativeDriver: true }),
          Animated.timing(hit, { toValue: 0, duration: 300, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        ]),
      ]);

    function ring() {
      if (reduceMotion.current) { schedule(); return; }
      // Struck, swings back harder, then settles — decaying like a real one.
      loop.current = Animated.sequence([
        strike(1, 140, 1),
        strike(-1, 210, 0.9),
        strike(0.5, 190, 0.5),
        Animated.timing(swing, { toValue: 0, duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
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
      // Reset, so the bell is never left mid-swing or mid-flash when the tab is
      // re-entered or the last notification is read.
      swing.setValue(0);
      hit.setValue(0);
    };
  }, [active, swing, hit]);

  const rotate = swing.interpolate({
    inputRange: [-1, 1],
    outputRange: [`-${SWING_DEG}deg`, `${SWING_DEG}deg`],
  });

  // Pivot at the crown, not the centre — a bell hangs from its top. React
  // Native rotates about the centre, so shift up, rotate, shift back.
  const pivot = size * 0.42;
  const img = { width: size, height: size } as const;

  // The enlarged notehead, centred on the measured one.
  const headSize = Math.round(size * HEAD_SCALE);
  const head = {
    position: 'absolute' as const,
    width: headSize,
    height: headSize,
    borderRadius: headSize / 2,
    left: Math.round(size * HEAD_X - headSize / 2),
    top: Math.round(size * HEAD_Y - headSize / 2),
  };
  const label = count > 9 ? '9+' : String(count);

  return (
    <View style={[img, styles.wrap, style]}>
      <Animated.View
        pointerEvents="none"
        style={[
          img,
          { transform: [{ translateY: -pivot }, { rotate }, { translateY: pivot }] },
        ]}
      >
        <Image source={BELL} style={[img, { tintColor: tint }]} resizeMode="contain" />
        {unread && <View style={[head, { backgroundColor: tint }]} pointerEvents="none" />}

        {/* The same logo in the accent colour, faded in at the moment of impact.
            Cross-fading two tinted copies keeps this on the native driver —
            animating tintColor itself would force the JS driver and put the
            work back on the thread that renders the feed. The notehead lifts
            with it, so the counter is part of the strike rather than a sticker
            sitting still on a flashing bell. */}
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: hit }]} pointerEvents="none">
          <Image source={BELL} style={[img, { tintColor: accent }]} resizeMode="contain" />
          {unread && <View style={[head, { backgroundColor: accent }]} />}
        </Animated.View>

        {/* The number sits ABOVE both layers so it stays solid white through the
            flash instead of being washed out by it. */}
        {unread && (
          <View style={[head, styles.center]} pointerEvents="none">
            <Text
              style={[styles.count, { fontSize: Math.round(size * (label.length > 1 ? HEAD_FONT_2 : HEAD_FONT)) }]}
              numberOfLines={1}
              allowFontScaling={false}
            >
              {label}
            </Text>
          </View>
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
  // allowFontScaling is off on the Text itself: this glyph has to fit a fixed
  // circle, and a user's larger text setting would push it outside the notehead.
  count: { color: '#FFFFFF', fontWeight: '800', textAlign: 'center', includeFontPadding: false },
});
