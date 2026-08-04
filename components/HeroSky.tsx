import { useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, Animated, Easing, AccessibilityInfo } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

// Night sky for the Spotlight landing artwork.
//
// This replaced a lamp-and-cone illustration. A SMOOTH spotlight beam isn't
// buildable here: expo-linear-gradient only does linear gradients, and a
// border-drawn triangle can't carry a gradient at all — approximating the
// falloff with stacked shapes just looked like more shapes. A real soft cone
// needs react-native-svg (radial gradients + masks), which is a native dep and
// therefore a rebuild.
//
// Stars are the honest version of the same idea: they're points, so hard edges
// are correct, and depth comes from brightness rather than from geometry.
//
// The field is FIXED, unlike the drifting stars on SpotlightButton. That button
// is a small pill where a static pattern gets noticed; a sky is large and reads
// as wrong if the stars wander. Here they hold position and vary in brightness.

const STAR_COUNT = 30;
// A handful burn brighter and snap rather than breathe — the ones that catch
// your eye. Too many and the sky strobes.
const FLASHER_EVERY = 5;
// Kept clear of the middle so nothing sits behind the icon.
const CENTER = { x: 0.5, y: 0.5, rx: 0.22, ry: 0.3 };

const rand = (min: number, max: number) => min + Math.random() * (max - min);

type Star = {
  left: string; top: string; size: number;
  dim: number; bright: number; dur: number; delay: number; flasher: boolean;
};

function buildSky(): Star[] {
  const out: Star[] = [];
  let guard = 0;
  while (out.length < STAR_COUNT && guard++ < STAR_COUNT * 20) {
    const x = Math.random();
    const y = Math.random();
    // Skip the elliptical dead zone the artwork icon occupies.
    const dx = (x - CENTER.x) / CENTER.rx;
    const dy = (y - CENTER.y) / CENTER.ry;
    if (dx * dx + dy * dy < 1) continue;
    const flasher = out.length % FLASHER_EVERY === 0;
    out.push({
      left: `${(x * 100).toFixed(2)}%`,
      top: `${(y * 100).toFixed(2)}%`,
      size: flasher ? rand(2, 3) : rand(1, 2),
      dim: flasher ? 0.12 : rand(0.1, 0.28),
      bright: flasher ? rand(0.9, 1) : rand(0.4, 0.7),
      dur: flasher ? rand(420, 700) : rand(1300, 2600),
      delay: rand(0, 4200),
      flasher,
    });
  }
  return out;
}

function Twinkle({ star }: { star: Star }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.delay(star.delay),
      Animated.timing(v, { toValue: 1, duration: star.dur, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(v, { toValue: 0, duration: star.dur, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      // Flashers rest longer than they burn, so a bright snap stays an event.
      Animated.delay(star.flasher ? rand(2200, 5200) : rand(300, 1400)),
    ]));
    loop.start();
    return () => loop.stop();
  }, [star, v]);

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.star,
        {
          left: star.left as any, top: star.top as any,
          width: star.size, height: star.size, borderRadius: star.size / 2,
          opacity: v.interpolate({ inputRange: [0, 1], outputRange: [star.dim, star.bright] }),
        },
      ]}
    />
  );
}

// A streak that crosses the sky now and then. Travel is one native-driver
// translate pair; only the between-runs wait touches JS.
function Shooter({ delay, top, len }: { delay: number; top: string; len: number }) {
  const v = useRef(new Animated.Value(0)).current;
  const [gen, setGen] = useState(0);
  // Re-rolled per run so the streaks never trace the same line twice.
  const path = useMemo(() => ({ from: rand(-0.15, 0.25), drop: rand(40, 90) }), [gen]);

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      v.setValue(0);
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(v, { toValue: 1, duration: rand(700, 1000), easing: Easing.in(Easing.quad), useNativeDriver: true }),
        Animated.delay(rand(4000, 9000)),
      ]).start(({ finished }) => { if (finished && !cancelled) { setGen((g) => g + 1); run(); } });
    };
    run();
    return () => { cancelled = true; v.stopAnimation(); };
    // `gen` deliberately excluded: re-running on it would restart mid-flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delay, v]);

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: top as any,
        left: `${path.from * 100}%`,
        width: len, height: 1.6,
        opacity: v.interpolate({ inputRange: [0, 0.15, 0.75, 1], outputRange: [0, 0.9, 0.5, 0] }),
        transform: [
          { translateX: v.interpolate({ inputRange: [0, 1], outputRange: [0, 190] }) },
          { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, path.drop] }) },
          { rotate: '22deg' },
        ],
      }}
    >
      {/* Tapered head-to-tail, so it reads as motion rather than a floating dash. */}
      <LinearGradient
        colors={['rgba(255,255,255,0)', 'rgba(233,213,255,0.95)']}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}

export default function HeroSky() {
  const [reduceMotion, setReduceMotion] = useState(false);
  // Built once — a sky that re-rolls on every render would shimmer wrongly.
  const sky = useMemo(buildSky, []);

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => { if (alive) setReduceMotion(on); })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { alive = false; sub?.remove?.(); };
  }, []);

  // Reduce Motion keeps the sky, frozen at each star's midpoint. The stars are
  // the artwork; only the twinkle and the streaks are the flourish.
  if (reduceMotion) {
    return (
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        {sky.map((s, i) => (
          <View
            key={i}
            style={[
              styles.star,
              {
                left: s.left as any, top: s.top as any,
                width: s.size, height: s.size, borderRadius: s.size / 2,
                opacity: (s.dim + s.bright) / 2,
              },
            ]}
          />
        ))}
      </View>
    );
  }

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {sky.map((s, i) => <Twinkle key={i} star={s} />)}
      <Shooter delay={1400} top="18%" len={54} />
      <Shooter delay={6200} top="34%" len={42} />
    </View>
  );
}

const styles = StyleSheet.create({
  star: { position: 'absolute', backgroundColor: '#FFFFFF' },
});
