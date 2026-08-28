import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, StyleSheet, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import AuthBackdrop from './AuthBackdrop';

// The bridge between signing in and the app appearing.
//
// WHY THIS HAS TO EXIST, and it is not really a cosmetic reason.
//
// app/_layout.tsx keys the whole per-user tree on the user id, deliberately —
// without it, a second account signing in on the same device inherits the
// previous one's cached profile, stories and now-playing for a beat. On sign-in
// that key changes from 'signed-out' to the id, so React unmounts and rebuilds
// everything under it. Including the sign-in screen the user is still looking at.
//
// So between tapping Log in and the feed arriving, the form VISIBLY RESET:
// fields blank, logo replaying from the start, button back to idle. The owner
// described it as looking like a freeze or a glitch, and he was reading it
// correctly — it looks exactly like a failed submit.
//
// The key cannot go; it is preventing a genuine data-leak between accounts. So
// this covers the handoff instead: from the moment the session arrives to the
// moment the app has routed, the user sees a steady branded screen rather than
// the machinery. The wait was always there — roughly two seconds of profile
// fetch and account checks — and this makes it read as the app opening rather
// than as the form failing.
//
// It must be rendered OUTSIDE the keyed view, or it would be torn down by the
// very remount it exists to hide.

const IN_MS = 260;
const OUT_MS = 320;

export default function AuthHandoff({ visible }: { visible: boolean }) {
  const { colors } = useTheme();
  // Kept mounted through the fade-out so the reveal is a fade rather than a cut.
  const [mounted, setMounted] = useState(visible);
  const fade = useRef(new Animated.Value(0)).current;
  // The mark settles in rather than appearing at full size — a small move, but
  // it is the difference between "a screen arrived" and "something is loading".
  const rise = useRef(new Animated.Value(0.94)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      fade.setValue(0);
      rise.setValue(0.94);
      Animated.parallel([
        Animated.timing(fade, { toValue: 1, duration: IN_MS, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(rise, { toValue: 1, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]).start();
      return;
    }
    // Fading OUT reveals whatever mounted underneath. Unmount only once the
    // animation is done, so this never blinks off mid-fade.
    Animated.timing(fade, {
      toValue: 0, duration: OUT_MS, easing: Easing.in(Easing.quad), useNativeDriver: true,
    }).start(({ finished }) => { if (finished) setMounted(false); });
  }, [visible, fade, rise]);

  if (!mounted) return null;

  return (
    <Animated.View
      // Swallows taps for as long as it is up: the screen underneath is being
      // rebuilt, and a tap landing on a half-mounted tree is how you get a
      // crash report nobody can reproduce.
      style={[StyleSheet.absoluteFill, styles.fill, { backgroundColor: colors.background, opacity: fade }]}
    >
      {/* progress={1} — steady, strong warmth with the breathing damped out.
          This is a moment of arrival, not a moment of waiting, so nothing here
          should pulse. */}
      <AuthBackdrop progress={1} />
      <View style={styles.center}>
        <Animated.View style={{ transform: [{ scale: rise }] }}>
          <Image source={require('../assets/icon.png')} style={styles.mark} resizeMode="cover" />
        </Animated.View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // zIndex as well as order: this sits among providers, and relying on JSX order
  // alone would put it behind anything that later gains its own elevation.
  fill: { zIndex: 100 },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  mark: { width: 96, height: 96, borderRadius: 26 },
});
