import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { impactLight } from '../lib/haptics';

// ── Double-tap-to-like (global) ──────────────────────────────────────────────
// One shared primitive so every surface (feed / post viewer / reels) behaves
// identically. Deliberately SURGICAL: it does NOT wrap or intercept the media's
// own gestures (slideshow swipe, reel pager, video controls stay untouched) —
// callers route their EXISTING onPress through `onTap`, and drop `heart` (an
// absolutely-positioned, pointer-events-none overlay) inside the media frame.
//
// Disambiguation: a tap within DOUBLE_TAP_MS of the previous one is a double-tap
// → like + heart burst; otherwise the caller's single-tap action fires after
// that same window (so a first tap that turns into a double never also opens /
// toggles). Double-tap ALWAYS likes and never un-likes (Instagram behavior);
// un-liking stays on the heart button.
const DOUBLE_TAP_MS = 260;

// Big white heart that pops over the media on a like. Keyed re-runs by `trigger`.
function HeartBurst({ trigger }: { trigger: number }) {
  const scale = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!trigger) return; // initial mount (trigger 0) — nothing to animate yet
    scale.setValue(0.3);
    opacity.setValue(0);
    Animated.sequence([
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, friction: 4, tension: 90, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 130, useNativeDriver: true }),
      ]),
      Animated.delay(320),
      Animated.parallel([
        Animated.timing(scale, { toValue: 1.35, duration: 240, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0, duration: 240, useNativeDriver: true }),
      ]),
    ]).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger]);
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
      <Animated.View style={{ opacity, transform: [{ scale }] }}>
        <Ionicons name="heart" size={92} color="#fff" style={styles.shadow} />
      </Animated.View>
    </View>
  );
}

export function useDoubleTapLike(opts: { isLiked: boolean; onLike: () => void }) {
  // Latest inputs read at tap time (keeps the handlers' identity stable).
  const ref = useRef(opts);
  ref.current = opts;
  const lastTap = useRef(0);
  const singleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [trigger, setTrigger] = useState(0);
  useEffect(() => () => { if (singleTimer.current) clearTimeout(singleTimer.current); }, []);

  const fireLike = useCallback(() => {
    impactLight();
    if (!ref.current.isLiked) ref.current.onLike(); // never un-like on double-tap
    setTrigger((t) => t + 1);
  }, []);

  // DEFERRED single-tap: a tap runs its single-tap action only if it doesn't
  // become a double within the window — so a double-tap NEVER also fires the
  // single action (open a post, pause a reel, toggle reel controls). The single
  // action is passed IN so each caller controls exactly what runs (and can guard
  // it — e.g. reels only pause if this page is still the active one at fire time,
  // since a fast tap-then-swipe must not land a stale pause on the next reel).
  const onTap = useCallback((onSingle?: () => void) => {
    const now = Date.now();
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      if (singleTimer.current) { clearTimeout(singleTimer.current); singleTimer.current = null; }
      fireLike();
    } else {
      lastTap.current = now;
      if (singleTimer.current) clearTimeout(singleTimer.current);
      const run = onSingle;
      singleTimer.current = setTimeout(() => {
        singleTimer.current = null;
        lastTap.current = 0;
        run?.();
      }, DOUBLE_TAP_MS);
    }
  }, [fireLike]);

  return { onTap, heart: <HeartBurst trigger={trigger} /> };
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  shadow: { textShadowColor: 'rgba(0,0,0,0.35)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 8 },
});
