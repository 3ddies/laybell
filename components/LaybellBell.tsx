import { useEffect, useRef } from 'react';
import { View, Image, Text, Animated, Easing, StyleSheet, AccessibilityInfo, type ViewStyle } from 'react-native';

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

// A black keyline under the mark was tried in light mode, first on both states
// and then narrowed to the red one, and removed on 2026-07-30: dilating this
// logo fills the thin gap between the note and the dome faster than it defines
// the rim, in either colour. The mark is left exactly as the artwork draws it.
const SWING_DEG = 13;
// Not halved with the gaps below. This one is not a frequency — it is the pause
// that keeps the first ring out of the tab's entrance animation.
const FIRST_DELAY_MS = 2400;
// Halved 2026-07-30 (was 17s/33s). Safe, because the ring is already boxed in on
// three sides and doubling its rate does not widen any of them:
//   * it only runs while `unread && focused`, so a read inbox or a backgrounded
//     tab rings never, at any interval;
//   * both animations are on the NATIVE driver, so the rate is nothing to the JS
//     thread — the duty cycle goes from ~3% to ~7% of native compositing on an
//     860ms sequence, against a screen that is already animating a feed;
//   * Reduce Motion still short-circuits before any animation starts. It costs
//     one extra no-op timer a minute there, which is not worth a special case.
// The randomised spread is kept: a fixed period reads as a metronome, and the
// point is a bell that occasionally rings, not one that ticks.
const GAP_MIN_MS = 8_500;
const GAP_MAX_MS = 16_500;

// Unread-count badge (owner, 2026-09-23) — a red pill that DROPS OUT of the
// bell's base, shows the number of unread notifications for ~3s, then retracts,
// the way Instagram/TikTok reveal a count. It drops when a fresh one lands and
// again on every Nth ring to pull the eye back; N is a few rings, not every one,
// so it emphasises rather than nags.
const BADGE_POP_EVERY = 3;
const BADGE_HOLD_MS = 3000;   // how long the count stays out before it retracts
const BADGE_MAX = 999;

export default function LaybellBell({
  matchIconSize = 28, color, unreadColor, accent = '#FF8095', unread, focused, style,
  count = 0,
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
  /** Unread-notification count for the badge. 0 hides it; over 999 shows "999+". */
  count?: number;
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

  // ── Unread-count badge ──────────────────────────────────────────────────────
  const countRef = useRef(count); countRef.current = count;   // read inside the ring loop
  const ringCountRef = useRef(0);
  const reveal = useRef(new Animated.Value(0)).current;       // 0 tucked away, 1 dropped out
  const revealSeq = useRef<Animated.CompositeAnimation | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const numPop = useRef(new Animated.Value(0)).current;       // a beat of life on the digit itself

  // Drop the badge out, hold, retract. In a ref so the ring loop (a stale
  // closure) always drives the current badge, and both triggers — a fresh
  // notification and every Nth ring — share one definition.
  const showBadge = useRef<() => void>(() => {});
  showBadge.current = () => {
    if (countRef.current <= 0) return;
    revealSeq.current?.stop();
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    if (reduceMotion.current) {
      reveal.setValue(1);
      hideTimer.current = setTimeout(() => reveal.setValue(0), BADGE_HOLD_MS);
      return;
    }
    revealSeq.current = Animated.sequence([
      Animated.spring(reveal, { toValue: 1, friction: 6, tension: 180, useNativeDriver: true }),
      Animated.delay(BADGE_HOLD_MS),
      Animated.timing(reveal, { toValue: 0, duration: 300, easing: Easing.in(Easing.quad), useNativeDriver: true }),
    ]);
    revealSeq.current.start();
    // A quick settle on the digit a beat after it lands, so the number reads as
    // alive rather than stamped on.
    numPop.setValue(0);
    Animated.sequence([
      Animated.delay(210),
      Animated.timing(numPop, { toValue: 1, duration: 120, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.spring(numPop, { toValue: 0, friction: 4, tension: 180, useNativeDriver: true }),
    ]).start();
  };

  // The reveal is RING-TIMED (see the ring loop): the first ring drops it out,
  // so the user watches it happen live a beat after opening rather than finding
  // it already sitting there. So the initial 0 -> n load is deliberately silent
  // here — it only marks the count as loaded. A genuinely NEW one that lands
  // afterwards drops live; reading everything (n -> 0) snaps it away.
  const prevCount = useRef(count);
  const loaded = useRef(count > 0);
  useEffect(() => {
    const prev = prevCount.current;
    prevCount.current = count;
    if (count <= 0) { loaded.current = false; revealSeq.current?.stop(); reveal.setValue(0); return; }
    if (!loaded.current) { loaded.current = true; return; }  // first load — let the ring reveal it
    if (count > prev) showBadge.current();
  }, [count, reveal]);

  // Stop the sequence and its hold timer on unmount.
  useEffect(() => () => {
    revealSeq.current?.stop();
    if (hideTimer.current) clearTimeout(hideTimer.current);
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
      // Drop the unread badge out on the FIRST ring (so the count reveals itself
      // live, just after opening), then on every few rings after, so the eye
      // keeps coming back to it. (% N === 1 fires on rings 1, 1+N, 1+2N, …)
      ringCountRef.current += 1;
      if (countRef.current > 0 && ringCountRef.current % BADGE_POP_EVERY === 1) showBadge.current();
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
        <Image source={BELL} style={[img, { tintColor: tint }]} resizeMode="contain" />

        {/* Accent copy, faded in at each strike. Cross-fading two tinted copies
            keeps this on the native driver — animating tintColor would force the
            JS driver and put the work back on the thread rendering the feed. */}
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: hit }]}>
          <Image source={BELL} style={[img, { tintColor: accent }]} resizeMode="contain" />
        </Animated.View>
      </Animated.View>

      {/* The count drops out of the bell's base, holds ~3s, then retracts. The
          anchor spans the bell box and centres the pill under it; the pill
          inside animates. A sibling of the swinging bell, not a child, so the
          swing above it never carries it. */}
      {count > 0 && (
        <View pointerEvents="none" style={[styles.badgeAnchor, { top: bodySize + 10 }]}>
          <Animated.View
            style={[
              styles.badge,
              // The bell's own unread red, so the badge and the ringing logo are
              // the same colour.
              { backgroundColor: unreadColor },
              {
                opacity: reveal.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: 'clamp' }),
                transform: [
                  { translateY: reveal.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) },
                  { scale: reveal.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }) },
                ],
              },
            ]}
          >
            {/* Speech-bubble lip, dead-centred on the rectangle (the wrapper
                spans the badge and centres it) and pointing up at the bell. Two
                centred copies — the red base and an accent one that flashes with
                the ring like the body — so the whole bubble pulses together. */}
            <View pointerEvents="none" style={styles.tailWrap}>
              <View style={[styles.badgeTail, { borderBottomColor: unreadColor }]} />
            </View>
            <Animated.View pointerEvents="none" style={[styles.tailWrap, { opacity: hit }]}>
              <View style={[styles.badgeTail, { borderBottomColor: accent }]} />
            </Animated.View>

            {/* Flashes to the bell's accent at each strike, off the SAME `hit`
                value the logo uses — so when the bell is out and ringing, the
                pill pulses in time with it. */}
            <Animated.View
              pointerEvents="none"
              style={[StyleSheet.absoluteFill, styles.badgeFlash, { backgroundColor: accent, opacity: hit }]}
            />
            <Animated.View style={{ transform: [{ scale: numPop.interpolate({ inputRange: [0, 1], outputRange: [1, 1.22] }) }] }}>
              <Text style={styles.badgeText} numberOfLines={1}>
                {count > BADGE_MAX ? `${BADGE_MAX}+` : String(count)}
              </Text>
            </Animated.View>
          </Animated.View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Full width of the bell box, centring the pill under it; `top` is set inline
  // from the measured body size so it hangs off the base.
  badgeAnchor: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  // A rounded rectangle, Instagram-style: corners clearly rounded (~a third of
  // the height) but the body stays rectangular. minWidth is wider than the
  // height so even a single digit is a horizontal rectangle, not a square; the
  // padding lets it grow. Colour is inline (the bell's unread red); a soft
  // shadow lifts it off the feed.
  badge: {
    minWidth: 42,
    height: 30,
    borderRadius: 10,
    paddingHorizontal: 11,
    alignItems: 'center',
    justifyContent: 'center',
    // No overflow:hidden — on iOS that clips the shadow. The flash overlay
    // carries its own matching radius instead.
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 3.5,
    shadowOffset: { width: 0, height: 2 },
  },
  badgeFlash: { borderRadius: 10 },
  // A full-width strip just above the badge that CENTRES the lip on the
  // rectangle; its top overlaps the badge edge by ~1pt to hide the seam.
  tailWrap: { position: 'absolute', top: -6, left: 0, right: 0, alignItems: 'center' },
  // The lip itself: a CSS-border triangle pointing UP toward the bell. Colour is
  // set inline (the bell's red, or the accent while flashing).
  badgeTail: {
    width: 0,
    height: 0,
    borderLeftWidth: 8,
    borderRightWidth: 8,
    borderBottomWidth: 7,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  // Bold SF with tabular figures — the iOS count look: heavy enough to read at a
  // glance, tabular so the digits stay aligned and never jitter as the count
  // changes.
  badgeText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 0.2,
    includeFontPadding: false,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
});

