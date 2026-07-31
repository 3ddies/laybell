import { useEffect, useRef } from 'react';
import { View, Image, Animated, Easing, StyleSheet, AccessibilityInfo, type ViewStyle } from 'react-native';

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
// Per-row ink analysis of the alpha channel. Nothing here
// is eyeballed, which is why the alignment holds if the asset is ever regenerated
// (re-run the measurement, update these six numbers).
const BELL = require('../assets/bell-icon.png');

// ── Matching the Ionicons sibling ──────────────────────────────────────────
// `size={28}` on an Ionicon sets the EM, not the drawing. The glyph inside is
// smaller than that and is not centred in its text box, so sizing the bell to 28
// made it taller than the chat bubble beside it and sat it slightly low.
//
// Both numbers are read out of Ionicons.ttf for `chatbubbles-outline`
// (unitsPerEm 512, ink y -34..415, hhea ascender 454 / descender -71 /
// lineGap 46), not estimated:
//   ink height        449/512 = 0.8770 em  -> 24.55pt at size 28
//   ink centre offset  -22/512 = 0.0430 em ABOVE the text box centre
const SIBLING_INK_H = 449 / 512;
const SIBLING_INK_DY = -22 / 512;

// Final correction, and the one number here that is NOT derivable from the font.
//
// The tables give the glyph's ink box exactly (449 units, confirmed against all
// 120 outline points, not just the header bbox). What they cannot say is where
// iOS puts the baseline inside the text box, because that depends on how the
// platform distributes the font's 46-unit lineGap — above the ascent, below the
// descent, or split. Those three choices differ by up to 2.5pt at size 28.
//
// With the top confirmed aligned on device, this stretches the bell DOWNWARD
// only: the box grows by this much and is shifted down by half of it, so the
// dome apex stays exactly where it is and the base descends. Expressed per
// matchIconSize so it scales with the icon.
//
// If the base ever overshoots or undershoots, this is the single number to
// change — nothing else in this file needs touching.
const BASE_EXTEND = 1.0 / 28;

// The note's stem and flag stick out ABOVE the dome, so the image is taller than
// the bell. These bound the BODY only — apex of the dome to the base.
//
// BODY_TOP is the row where the dome's arch first appears. Finding it needs
// care: the note's stem runs down the middle and its FLAG curves out to the
// right, so "first row wider than X" and "first ink outside the stem" both catch
// the note instead of the bell. The dome is the only thing that ever puts ink
// well LEFT of the stem, so that is the test — leftmost ink crossing clearly
// left of the stem's edge, which happens at y 160 of 752.
//
// An earlier "45% of the widest row" heuristic put this at y 198, 38px too low.
// That made the drawn bell 26.37pt apex-to-base against a 24.55pt chat bubble —
// 1.82pt too tall, which is exactly the mismatch this replaces.
const BODY_TOP = 0.2128;    // dome apex, as a fraction of image height
const BODY_BOT = 0.9468;    // base
const BODY_H = BODY_BOT - BODY_TOP;              // 0.7340
const BODY_MID = (BODY_TOP + BODY_BOT) / 2;      // 0.5798

// ── The light-mode outline ─────────────────────────────────────────────────
// In light mode the mark is near-black on a warm off-white, and the asset's
// anti-aliased edge fades into that background — the same softness that made it
// read brownish before the density variants landed. Density fixed the COLOUR;
// this fixes the EDGE.
//
// It is a one-pass dilation, not a stroke: eight copies of the same silhouette,
// offset around the compass and drawn under the real one. The glyph grows by
// `outline` all round, so its boundary lands on solid colour instead of a
// gradient into the page. Diagonals are pulled in to ~0.707 so all eight offsets
// are the same DISTANCE from centre — at full 1.0 the corners would bulge.
//
// Eight rather than four: four leaves visible flat spots on the dome's curve,
// which is most of this logo's outline.
//
// Dark mode passes no outline at all. A white mark on near-black already has the
// contrast, and dilating it there would just thicken the logo.
const OUTLINE_RATIO = 0.6 / 28;
const D = Math.SQRT1_2;
const OUTLINE_DIRS: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [D, D], [-D, D], [D, -D], [-D, -D],
];

const SWING_DEG = 13;
const FIRST_DELAY_MS = 2400;
const GAP_MIN_MS = 17_000;
const GAP_MAX_MS = 33_000;

export default function LaybellBell({
  matchIconSize = 28, color, unreadColor, accent = '#FF8095', unread, focused, outline, style,
}: {
  /** The `size` prop given to the Ionicon beside this one. The bell's BODY is
   *  then matched to that glyph's real drawn height and vertical position — not
   *  to the nominal size, which is the em and is bigger than the drawing. Pass
   *  the same number the sibling icon uses and the two line up. */
  matchIconSize?: number;
  /** Resting colour once everything has been read. */
  color: string;
  /** Colour the mark takes while unread. This replaces the old count badge. */
  unreadColor: string;
  /** Flashed at each strike. A LIFT of the unread red, not another hue — the
   *  bell is already red, so a red flash would be invisible. */
  accent?: string;
  /** Whether anything is unread. The mark is the whole indicator — there is no
   *  count anywhere on it, deliberately: the bell answers "is there something
   *  new", and the messages icon beside it is where a number belongs. */
  unread: boolean;
  /** Animation runs only while the screen is on. */
  focused: boolean;
  /** Colour to dilate the silhouette with, under the mark — see OUTLINE_RATIO.
   *  Pass it in LIGHT MODE ONLY; omit it and nothing is drawn, which is what dark
   *  mode wants. The caller decides rather than this component reading the theme,
   *  matching how `color` and `unreadColor` already arrive. */
  outline?: string;
  style?: ViewStyle;
}) {
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
  // The bell BODY is matched to the sibling glyph's drawn height, and the whole
  // thing is nudged up by the same amount that glyph's ink sits above its own
  // text box centre. Both come from the font, so the two line up top and bottom
  // in a row that centres its children.
  // Grow by `extend` and shift down by half of it: the top lands exactly where
  // it did, the base descends by `extend`. See BASE_EXTEND.
  const extend = matchIconSize * BASE_EXTEND;
  const bodySize = matchIconSize * SIBLING_INK_H + extend;
  const nudgeY = matchIconSize * SIBLING_INK_DY + extend / 2;

  const imgSize = bodySize / BODY_H;
  const imgTop = bodySize / 2 - BODY_MID * imgSize;
  const imgLeft = (bodySize - imgSize) / 2;
  const img = { position: 'absolute' as const, top: imgTop, left: imgLeft, width: imgSize, height: imgSize };

  // Rotate about the dome's apex — a bell hangs from its crown, not its middle.
  const pivotFromCentre = BODY_TOP * imgSize + imgTop - bodySize / 2;

  // overflow visible is declared rather than assumed on both levels below: the
  // note's flag deliberately hangs ~11pt ABOVE this box (that is the whole point
  // of sizing off the body), and a clipped ancestor would lop the top off the
  // logo. Nothing in the header sets overflow hidden today — this keeps it
  // working if something later does.
  return (
    <View
      style={[
        { width: bodySize, height: bodySize, overflow: 'visible' },
        // translateY, not margin: a transform shifts the drawing without
        // changing the layout box, so the header's spacing is untouched.
        { transform: [{ translateY: nudgeY }] },
        style,
      ]}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { overflow: 'visible' },
          { transform: [{ translateY: pivotFromCentre }, { rotate }, { translateY: -pivotFromCentre }] },
        ]}
      >
        {/* Under the mark, so the real silhouette covers all but the rim. Inside
            the rotating layer, so the outline swings with the bell rather than
            sitting still behind a moving one. */}
        {!!outline && OUTLINE_DIRS.map(([dx, dy], i) => (
          <Image
            key={i}
            source={BELL}
            style={[
              img,
              {
                tintColor: outline,
                transform: [
                  { translateX: dx * matchIconSize * OUTLINE_RATIO },
                  { translateY: dy * matchIconSize * OUTLINE_RATIO },
                ],
              },
            ]}
            resizeMode="contain"
          />
        ))}

        <Image source={BELL} style={[img, { tintColor: tint }]} resizeMode="contain" />

        {/* Accent copy, faded in at each strike. Cross-fading two tinted copies
            keeps this on the native driver — animating tintColor would force the
            JS driver and put the work back on the thread rendering the feed. */}
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: hit }]}>
          <Image source={BELL} style={[img, { tintColor: accent }]} resizeMode="contain" />
        </Animated.View>
      </Animated.View>
    </View>
  );
}

