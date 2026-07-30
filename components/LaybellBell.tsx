import { useEffect, useRef } from 'react';
import { View, Text, Image, Animated, Easing, StyleSheet, AccessibilityInfo, type ViewStyle } from 'react-native';

// The Laybell bell — the actual logo, sized and aligned off the BELL BODY.
//
// ── Why an image and not icons or SVG ───────────────────────────────────────
// assets/bell-icon.png is generated from assets/android-icon-monochrome.png,
// the brand mark as a white silhouette in the alpha channel, cropped to the ink
// and re-padded square. Every pixel is a source pixel; nothing is redrawn.
// White + alpha is what tintColor wants, so one asset serves every theme and
// the accent flash.
//
// react-native-svg would allow the note to swing independently of the bell, but
// it is a NATIVE module — a rebuild, and every dev client invalidated. On the
// real artwork the bell and note are a SINGLE connected component (the stem
// crosses the dome), so splitting them means redrawing the logo. The whole bell
// rocks instead, which is what a struck bell does.
//
// ── Everything below is MEASURED from the artwork ───────────────────────────
// Per-row ink analysis, and a distance transform for the notehead. Nothing here
// is eyeballed, which is why the alignment holds if the asset is ever regenerated
// (re-run the measurement, update these six numbers).
const BELL = require('../assets/bell-icon.png');

// The note's stem and flag stick out ABOVE the dome, so the image is taller than
// the bell. Sizing off the image would leave the bell visibly smaller than the
// icon beside it and sitting too low. These bound the BODY only.
const BODY_TOP = 0.2633;    // dome apex, as a fraction of image height
const BODY_BOT = 0.9468;    // base
const BODY_H = BODY_BOT - BODY_TOP;              // 0.6835
const BODY_MID = (BODY_TOP + BODY_BOT) / 2;      // 0.6051

// The note's head: centre and diameter as fractions of the image, from the
// largest circle that fits inside the mark.
const HEAD_X = 0.463;
const HEAD_Y = 0.723;
const HEAD_D = 0.194;
// Digits are narrow, so they can run a little larger than the inscribed circle
// without touching the head's edge.
const HEAD_FONT = 0.80;     // of the head's diameter, single digit
const HEAD_FONT_2 = 0.58;   // for "9+"

const SWING_DEG = 13;
const FIRST_DELAY_MS = 2400;
const GAP_MIN_MS = 17_000;
const GAP_MAX_MS = 33_000;

export default function LaybellBell({
  bodySize = 28, color, unreadColor, accent = '#FF8095', count, focused, style,
}: {
  /** Height the BELL BODY should occupy — set it to the size of the icon beside
   *  it and the two line up top and bottom. The image itself is rendered larger
   *  so the note's flag can overhang, which is why this isn't called `size`. */
  bodySize?: number;
  /** Resting colour once everything has been read. */
  color: string;
  /** Colour the mark takes while unread. This replaces the old count badge. */
  unreadColor: string;
  /** Flashed at each strike. A LIFT of the unread red, not another hue — the
   *  bell is already red, so a red flash would be invisible. */
  accent?: string;
  /** Unread count, drawn inside the note's head. 0 shows nothing. */
  count: number;
  /** Animation runs only while the screen is on. */
  focused: boolean;
  style?: ViewStyle;
}) {
  const unread = count > 0;
  const active = unread && focused;
  const tint = unread ? unreadColor : color;

  const swing = useRef(new Animated.Value(0)).current;
  const hit = useRef(new Animated.Value(0)).current;
  const loop = useRef<Animated.CompositeAnimation | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduceMotion = useRef(false);

  // Respect the OS "Reduce Motion" setting.
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
      loop.current = Animated.sequence([
        strike(1, 140, 1),
        strike(-1, 210, 0.9),
        strike(0.5, 190, 0.5),
        Animated.timing(swing, { toValue: 0, duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]);
      loop.current.start(({ finished }) => { if (finished) schedule(); });
    }

    function schedule() {
      timer.current = setTimeout(ring, GAP_MIN_MS + Math.random() * (GAP_MAX_MS - GAP_MIN_MS));
    }

    timer.current = setTimeout(ring, FIRST_DELAY_MS);

    return () => {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      loop.current?.stop();
      loop.current = null;
      swing.setValue(0);
      hit.setValue(0);
    };
  }, [active, swing, hit]);

  const rotate = swing.interpolate({
    inputRange: [-1, 1],
    outputRange: [`-${SWING_DEG}deg`, `${SWING_DEG}deg`],
  });

  // ── Layout ────────────────────────────────────────────────────────────────
  // The box is bodySize square so it occupies the same room as the icon beside
  // it. The image is bigger and overhangs, positioned so the BODY's midline
  // lands on the box's midline — which is what makes the two line up.
  const imgSize = bodySize / BODY_H;
  const imgTop = bodySize / 2 - BODY_MID * imgSize;
  const imgLeft = (bodySize - imgSize) / 2;
  const img = { position: 'absolute' as const, top: imgTop, left: imgLeft, width: imgSize, height: imgSize };

  // Rotate about the dome's apex — a bell hangs from its crown, not its middle.
  const pivotFromCentre = BODY_TOP * imgSize + imgTop - bodySize / 2;

  // The number, centred on the real notehead. Deliberately NOT an enlarged
  // circle: the head is part of the logo and stays the size it was drawn.
  const headD = HEAD_D * imgSize;
  const label = count > 9 ? '9+' : String(count);
  const headBox = {
    position: 'absolute' as const,
    left: imgLeft + HEAD_X * imgSize - headD / 2,
    top: imgTop + HEAD_Y * imgSize - headD / 2,
    width: headD,
    height: headD,
  };

  // overflow visible is declared rather than assumed on both levels below: the
  // note's flag deliberately hangs ~11pt ABOVE this box (that is the whole point
  // of sizing off the body), and a clipped ancestor would lop the top off the
  // logo. Nothing in the header sets overflow hidden today — this keeps it
  // working if something later does.
  return (
    <View style={[{ width: bodySize, height: bodySize, overflow: 'visible' }, style]}>
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { overflow: 'visible' },
          { transform: [{ translateY: pivotFromCentre }, { rotate }, { translateY: -pivotFromCentre }] },
        ]}
      >
        <Image source={BELL} style={[img, { tintColor: tint }]} resizeMode="contain" />

        {/* Accent copy, faded in at each strike. Cross-fading two tinted copies
            keeps this on the native driver — animating tintColor would force the
            JS driver and put the work back on the thread rendering the feed. */}
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: hit }]}>
          <Image source={BELL} style={[img, { tintColor: accent }]} resizeMode="contain" />
        </Animated.View>

        {/* Above both tints, so the digit stays solid white through the flash.
            allowFontScaling off: this has to sit inside a fixed circle, and a
            larger system text setting would push it outside the head. */}
        {unread && (
          <View style={[headBox, styles.center]}>
            <Text
              style={[styles.count, { fontSize: Math.round(headD * (label.length > 1 ? HEAD_FONT_2 : HEAD_FONT)) }]}
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
  center: { alignItems: 'center', justifyContent: 'center' },
  count: { color: '#FFFFFF', fontWeight: '800', textAlign: 'center', includeFontPadding: false },
});
