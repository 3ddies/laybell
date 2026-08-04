import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, Easing, AccessibilityInfo } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { RADIUS, SPACING, type ThemePalette } from '../constants/theme';
import { useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

// The Music tab's Listen-mode pill. Enters a distraction-free mode (tab bar
// fades, tab swipes lock, notifications go quiet), so it's the one invitation on
// a screen otherwise made of filters — worth it looking like something.
//
// A single slow highlight travels across the fill, then rests for three seconds.
// The rest is the point: a continuous sweep would read as a loading bar, and on
// a screen you sit and browse, anything that never stops moving becomes
// something to ignore.
//
// It runs ONLY when the mode is off. Once you're in, the button's job is "exit",
// and a glinting exit button is noise. Reduce Motion drops the sweep entirely
// and leaves the plain pill — same contract the Premium card's bubbles use.
//
// Native driver throughout, so nothing here touches the JS thread after start.

// How long one pass takes, and how long the button rests between passes.
const SWEEP_MS = 1400;
const REST_MS = 3200;

export default function ListenButton({ active, onPress }: {
  /** Listen mode is currently ON — the button becomes "Exit". */
  active: boolean;
  onPress: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const [reduceMotion, setReduceMotion] = useState(false);
  // Measured so the highlight always crosses the full pill, whatever the label
  // is in the active language — a hardcoded range would under- or over-shoot.
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

  const animate = !active && !reduceMotion && width > 0;

  useEffect(() => {
    if (!animate) return;
    sweep.setValue(0);
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(sweep, { toValue: 1, duration: SWEEP_MS, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.delay(REST_MS),
    ]));
    loop.start();
    // Stopping is not enough on its own — a stopped value holds wherever it was,
    // which would strand the highlight mid-pill when Listen mode turns on.
    return () => { loop.stop(); sweep.setValue(0); };
  }, [animate, sweep]);

  const translateX = sweep.interpolate({
    inputRange: [0, 1],
    outputRange: [-width * 0.6, width * 1.3],
  });

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} accessibilityRole="button">
      <View style={styles.btn} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        {animate && (
          <Animated.View
            pointerEvents="none"
            style={[styles.shine, { transform: [{ translateX }, { rotate: '18deg' }] }]}
          />
        )}
        <Ionicons name={active ? 'close' : 'headset'} size={16} color={INK} />
        <Text style={styles.label}>{active ? t('music.exit') : t('music.listen')}</Text>
      </View>
    </TouchableOpacity>
  );
}

// Dark ink, matching the icon beside it. The old style set the label to #fff —
// roughly 1.9:1 on this yellow, which is why "Listen" read washed out next to
// its own dark glyph. The style's own comment already specified DARK glyphs;
// only the icon ever got them.
const INK = '#1C0E06';

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  // FLAT primaryLight, deliberately — this is the hex the home-page wordmark
  // uses, and the previous style carried a note that a gradient/glow made the
  // pill read brighter than the logo. The sheen adds life without touching the
  // fill, so that decision still stands.
  btn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: colors.primaryLight,
    borderRadius: RADIUS.full,
    paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md + 4,
    overflow: 'hidden',   // clips the sweep to the pill
  },
  // Tall enough that the 18° tilt still covers the pill top to bottom, and soft
  // enough to read as a sheen rather than a white bar crossing the button.
  shine: {
    position: 'absolute',
    top: -20, bottom: -20, width: 26,
    backgroundColor: 'rgba(255,255,255,0.30)',
  },
  label: { color: INK, fontSize: 14, fontWeight: '800', letterSpacing: 0.2 },
});
