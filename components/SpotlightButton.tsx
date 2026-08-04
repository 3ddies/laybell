import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, Easing, AccessibilityInfo } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { RADIUS, SPACING } from '../constants/theme';

// The Spotlight button on your own profile, themed to match the Spotlight card
// in Settings — same galaxy-purple gradient, same pin-prick star field — so the
// paid-promotion surface looks like one product wherever you meet it.
//
// The stars TWINKLE here, which the Settings card's don't: this button sits in a
// row of flat pills and has to earn a glance, whereas the Settings card is
// already a large coloured block. Each star breathes between its own dim and
// bright values on its own clock, so the field never pulses in unison — that
// would read as the whole button blinking rather than as starlight.

// Confined to the LEFT and RIGHT margins, clear of the icon + label in the
// middle: a dot behind the word would read as a rendering fault, and the label
// grows in longer languages. `top` suits the pill's ~32px height.
//
// `dur` and `delay` are deliberately co-prime-ish so the six never resynchronise
// into a visible rhythm.
const STARS = [
  { top: 6,  left: '7%',  size: 2,   dim: 0.35, bright: 1,    dur: 1600, delay: 0 },
  { top: 19, left: '4%',  size: 1.5, dim: 0.25, bright: 0.75, dur: 2300, delay: 700 },
  { top: 12, left: '14%', size: 1,   dim: 0.2,  bright: 0.6,  dur: 1900, delay: 1500 },
  { top: 8,  left: '89%', size: 2,   dim: 0.3,  bright: 0.95, dur: 2100, delay: 400 },
  { top: 21, left: '94%', size: 1.5, dim: 0.25, bright: 0.8,  dur: 1700, delay: 1200 },
  { top: 15, left: '83%', size: 1,   dim: 0.2,  bright: 0.55, dur: 2500, delay: 1900 },
] as const;

// Matches promoSpotlight in settings.tsx.
const GALAXY = ['#241147', '#3B1D8F', '#6D28D9'] as const;

export default function SpotlightButton({ onPress }: { onPress: () => void }) {
  const [reduceMotion, setReduceMotion] = useState(false);
  const anims = useRef(STARS.map(() => new Animated.Value(0))).current;

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => { if (alive) setReduceMotion(on); })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { alive = false; sub?.remove?.(); };
  }, []);

  useEffect(() => {
    if (reduceMotion) return;
    const loops = anims.map((v, i) => {
      const s = STARS[i];
      v.setValue(0);
      // Delay INSIDE the loop, so each star also rests between breaths instead
      // of running a continuous sine — real starlight catches and fades.
      const loop = Animated.loop(Animated.sequence([
        Animated.delay(s.delay),
        Animated.timing(v, { toValue: 1, duration: s.dur, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(v, { toValue: 0, duration: s.dur, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]));
      loop.start();
      return loop;
    });
    return () => loops.forEach((l) => l.stop());
  }, [reduceMotion, anims]);

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} accessibilityRole="button">
      <LinearGradient
        colors={GALAXY}
        start={{ x: 0, y: 1 }}
        end={{ x: 1, y: 0 }}
        style={styles.btn}
      >
        {STARS.map((s, i) => (
          <Animated.View
            key={i}
            pointerEvents="none"
            style={[
              styles.star,
              {
                top: s.top, left: s.left as any,
                width: s.size, height: s.size, borderRadius: s.size / 2,
                // Reduce Motion keeps the field, frozen at its midpoint — the
                // galaxy is the theme, the twinkle is the flourish.
                opacity: reduceMotion
                  ? (s.dim + s.bright) / 2
                  : anims[i].interpolate({ inputRange: [0, 1], outputRange: [s.dim, s.bright] }),
              },
            ]}
          />
        ))}
        <Ionicons name="sparkles" size={15} color="#fff" />
        <Text style={styles.label}>Spotlight</Text>
      </LinearGradient>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    borderRadius: RADIUS.full,
    paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md,
    overflow: 'hidden',   // keeps the star field inside the pill
  },
  star: { position: 'absolute', backgroundColor: '#FFFFFF' },
  label: { color: '#fff', fontSize: 13, fontWeight: '700' },
});
