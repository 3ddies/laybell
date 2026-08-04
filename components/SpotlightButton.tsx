import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, StyleSheet, TouchableOpacity, Animated, Easing, AccessibilityInfo, type LayoutRectangle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { RADIUS, SPACING } from '../constants/theme';

// The Spotlight button on your own profile, themed to match the Spotlight card
// in Settings — same galaxy-purple gradient — so the paid-promotion surface
// looks like one product wherever you meet it.
//
// Stars fade in somewhere in the pill, hold, fade out, and come back somewhere
// else. Fixed points that merely brighten read as a pattern once you've looked
// twice; appearing and vanishing reads as depth.
//
// HOW THIS STAYS CHEAP (this is decoration — it must cost nothing):
//  • A fixed pool of star views, created once. Nothing mounts or unmounts, so
//    there's no allocation churn while the screen is open.
//  • Each star owns its own position state, so a star moving re-renders ONE 2px
//    view — never the button, never the profile screen around it.
//  • Position changes only while the star is at opacity 0, so a move can never
//    be seen as a jump.
//  • Opacity-only animation, native driver, so nothing touches the JS thread
//    between cycles. Per star that's one setState roughly every 3–5 seconds.
//  • Reduce Motion renders no stars at all and leaves the gradient.

const STAR_COUNT = 6;
// Clearance around the label before a star is allowed to sit there.
const TEXT_PAD = 5;
// How many times to try for a free spot before giving up on a cycle. Bounded on
// purpose: the usable area is small, and a star that skips one turn is invisible
// to the user, whereas an unbounded search is a hang waiting to happen.
const MAX_TRIES = 8;

const rand = (min: number, max: number) => min + Math.random() * (max - min);

type Pos = { x: number; y: number; size: number; peak: number };

// One star: owns its position, its fade loop, and nothing else.
function Star({ pick }: { pick: () => Pos | null }) {
  const [pos, setPos] = useState<Pos | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let cancelled = false;

    const cycle = () => {
      if (cancelled) return;
      const next = pick();
      // No free spot this time (a long label in another language can crowd the
      // pill) — wait and try again rather than forcing an overlap.
      if (!next) { setTimeout(cycle, 900); return; }
      setPos(next);
      opacity.setValue(0);
      Animated.sequence([
        Animated.timing(opacity, { toValue: next.peak, duration: rand(700, 1100), easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.delay(rand(400, 900)),
        Animated.timing(opacity, { toValue: 0, duration: rand(700, 1100), easing: Easing.in(Easing.quad), useNativeDriver: true }),
        // The dark gap between appearances, randomised so the six never fall
        // into a shared rhythm.
        Animated.delay(rand(600, 2200)),
      ]).start(({ finished }) => { if (finished) cycle(); });
    };

    // Stagger the first appearance so they don't all bloom together on mount.
    const t = setTimeout(cycle, rand(0, 1800));
    // `cancelled` also covers the retry timeout above — cycle() bails on it
    // before touching state, so an unmount mid-wait is a no-op.
    return () => { cancelled = true; clearTimeout(t); opacity.stopAnimation(); };
  }, [pick, opacity]);

  if (!pos) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.star,
        { left: pos.x, top: pos.y, width: pos.size, height: pos.size, borderRadius: pos.size / 2, opacity },
      ]}
    />
  );
}

// Matches promoSpotlight in settings.tsx.
const GALAXY = ['#241147', '#3B1D8F', '#6D28D9'] as const;

export default function SpotlightButton({ onPress }: { onPress: () => void }) {
  const [reduceMotion, setReduceMotion] = useState(false);
  // Measured geometry lives in refs, not state: `pick` reads it at call time, so
  // a layout pass never has to re-run the effects that drive the stars.
  const pill = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const label = useRef<LayoutRectangle | null>(null);
  // Flips once, purely to kick off the first render that has geometry.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => { if (alive) setReduceMotion(on); })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { alive = false; sub?.remove?.(); };
  }, []);

  // Stable across renders (reads refs), so the stars' effects never re-run.
  const pick = useCallback((): Pos | null => {
    const { w, h } = pill.current;
    const t = label.current;
    if (!w || !h) return null;
    const size = [1, 1.5, 2][Math.floor(Math.random() * 3)];
    for (let i = 0; i < MAX_TRIES; i++) {
      const x = rand(0, w - size);
      const y = rand(0, h - size);
      const hitsLabel = t
        && x + size > t.x - TEXT_PAD && x < t.x + t.width + TEXT_PAD
        && y + size > t.y - TEXT_PAD && y < t.y + t.height + TEXT_PAD;
      if (!hitsLabel) return { x, y, size, peak: rand(0.55, 1) };
    }
    return null;
  }, []);

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} accessibilityRole="button">
      <LinearGradient
        colors={GALAXY}
        start={{ x: 0, y: 1 }}
        end={{ x: 1, y: 0 }}
        style={styles.btn}
        onLayout={(e) => {
          pill.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
          if (!ready) setReady(true);
        }}
      >
        {ready && !reduceMotion && Array.from({ length: STAR_COUNT }).map((_, i) => (
          <Star key={i} pick={pick} />
        ))}
        <Text
          style={styles.label}
          onLayout={(e) => { label.current = e.nativeEvent.layout; }}
        >
          Spotlight
        </Text>
      </LinearGradient>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderRadius: RADIUS.full,
    paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md,
    overflow: 'hidden',   // keeps stars inside the pill
  },
  star: { position: 'absolute', backgroundColor: '#FFFFFF' },
  label: { color: '#fff', fontSize: 13, fontWeight: '700' },
});
