import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo, ActivityIndicator, Animated, Easing,
  StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { RADIUS, SPACING, type ThemePalette } from '../constants/theme';
import { useThemedStyles } from '../contexts/ThemeContext';
import { LISTEN_FILL } from './ListenButton';
import { MARK_ANIMATION_MS } from './AuthLogoMark';

// The primary action on the auth screens: Log in, Create account, Save password.
//
// One component rather than three copies, because it now carries real behaviour
// — the gradient fill, the sweeping sheen, the loading state and the
// reduce-motion check — and three copies of that would drift within a release.
//
// THE SHEEN is deliberately the same idea as the Listen-mode pill, on the
// owner's ask, with the same timing constants: a short sweep, then a long rest.
// The rest is the important half. A highlight that crossed continuously would be
// a distraction sitting under a password field; one that crosses briefly every
// few seconds reads as a material catching the light.
//
// It respects Reduce Motion. Someone who has asked the OS to stop animations has
// asked for this too, and a sweeping highlight is exactly the kind of thing that
// setting exists for.
//
// It also stops while `loading` is true. During the wait the spinner IS the
// message, and a sheen crossing behind it just adds noise to the one moment the
// button most needs to say a single clear thing.

// Two rounds of owner tuning on device, and they moved independently — which is
// exactly why these are two constants rather than one "speed".
//   • SWEEP is how fast the bar crosses. 1400 → 950: "move a bit faster". Settled.
//   • REST is how often it happens at all. 4800 → 10550: "half as frequently".
// A full period is SWEEP + REST, so 5750ms became 11500ms — an actual halving of
// the frequency rather than just a longer pause.
//
// The rest is the half that protects the screen. This sits under a password
// field, and a highlight that returns too often stops reading as a material
// catching light and starts reading as something demanding attention.
const SWEEP_MS = 950;
const REST_MS = 10550;

// Hold the FIRST sweep until the logo has finished drawing itself in.
//
// The owner's words: a button flashing while the bell is still ringing is
// overstimulating. He is right, and it is worth naming why — two animations
// running at once on the first screen of the app means the eye has nowhere to
// settle, so neither one actually lands. Sequenced, they read as one considered
// arrival: the mark draws, it settles, and then the thing you are meant to press
// catches the light.
//
// Derived from the asset's real duration rather than hardcoded, so re-cutting
// the video cannot silently desynchronise these. The extra beat is a breath
// between the two, not a guess at the timing.
const START_DELAY_MS = MARK_ANIMATION_MS + 450;

type Props = {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
};

export default function AuthSubmitButton({ label, onPress, loading = false, disabled = false }: Props) {
  const styles = useThemedStyles(makeStyles);
  const [reduceMotion, setReduceMotion] = useState(false);
  // Measured so the sweep always crosses the full button whatever the label is
  // in the active language — a hardcoded range would under- or over-shoot.
  const [width, setWidth] = useState(0);
  const sweep = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => { if (alive) setReduceMotion(on); })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { alive = false; sub?.remove?.(); };
  }, []);

  const animate = !loading && !disabled && !reduceMotion && width > 0;

  useEffect(() => {
    if (!animate) return;
    sweep.setValue(0);
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(sweep, {
        toValue: 1, duration: SWEEP_MS, easing: Easing.inOut(Easing.quad), useNativeDriver: true,
      }),
      Animated.delay(REST_MS),
    ]));
    // A plain timer rather than Animated.delay in front of the loop: the loop has
    // to be stoppable on its own, and a delay wrapped around it would still be
    // pending — and would still fire — after loading started.
    const start = setTimeout(() => loop.start(), START_DELAY_MS);
    // Stopping alone is not enough: a stopped value holds wherever it stood,
    // which would strand the highlight mid-button the moment loading starts.
    return () => { clearTimeout(start); loop.stop(); sweep.setValue(0); };
  }, [animate, sweep]);

  const translateX = sweep.interpolate({
    inputRange: [0, 1],
    outputRange: [-width * 0.6, width * 1.3],
  });

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityState={{ disabled, busy: loading }}
      accessibilityLabel={label}
    >
      <View
        style={[styles.btn, disabled && styles.btnDisabled]}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      >
        <LinearGradient
          colors={LISTEN_FILL}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        {animate && (
          <Animated.View
            pointerEvents="none"
            style={[styles.shine, { transform: [{ translateX }, { rotate: '18deg' }] }]}
          />
        )}
        {loading
          ? <ActivityIndicator color="#FFFFFF" />
          : <Text style={styles.label} numberOfLines={1}>{label}</Text>}
      </View>
    </TouchableOpacity>
  );
}

const makeStyles = (_c: ThemePalette) => StyleSheet.create({
  btn: {
    alignItems: 'center', justifyContent: 'center',
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.md + 2,
    marginTop: SPACING.sm,
    overflow: 'hidden',   // clips the sweep to the button
  },
  btnDisabled: { opacity: 0.5 },
  // Tall enough that the 18° tilt still covers the button top to bottom, and
  // soft enough to read as a sheen rather than a white bar crossing it.
  shine: {
    position: 'absolute',
    top: -20, bottom: -20, width: 26,
    backgroundColor: 'rgba(255,255,255,0.30)',
  },
  // White in every display mode: the label sits on the gold end of the gradient
  // in light and dark alike, so it must not follow the theme text colour.
  label: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
});
