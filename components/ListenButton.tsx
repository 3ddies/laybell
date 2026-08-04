import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, Easing, AccessibilityInfo } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
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

// How long one pass takes, and how long the button rests between passes. The
// rest carries the whole cycle length: at 7800 the pill glints roughly every
// 9.2s, half as often as it did, so it reads as an occasional catch of light
// rather than something actively signalling.
const SWEEP_MS = 1400;
const REST_MS = 7800;

// NO text outline here, deliberately. The stacked-copy trick (see the Explore
// grid's music header) works on large display type, but at 14pt nine text
// layers land on subpixel boundaries and the edges go muddy — no amount of
// tuning stroke width or letter-spacing fixes that, because it's the technique
// failing at this size, not the values. One text layer, so the letterforms
// render exactly as the font draws them.
//
// Yellow-forward gradient (owner's choice): the wordmark gold leads at the top
// left and warms into the brand orange at the bottom right, so the pill still
// reads as the yellow button while the deeper end gives the white label
// somewhere to sit. Gold alone puts white at 1.79:1; across this fill it runs
// 1.79 → 3.15. Low by the numbers, and chosen on look.
//
// This knowingly sets aside an older note on the flat fill (that a gradient made
// the pill read brighter than the logo) — that note was written when the label
// was dark ink, and the owner has since asked for white letters and a gradient.
// Exported so any other surface asked to match this button draws from the same
// two hexes rather than re-typing them and drifting later.
export const LISTEN_FILL = ['#FAB525', '#F26522'] as const;
const FILL = LISTEN_FILL;

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

  // Resolved once — the outline renders it nine times over, and re-running t()
  // per copy would be nine lookups for one word.
  const label = active ? t('music.exit') : t('music.listen');

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} accessibilityRole="button">
      <View style={styles.btn} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        <LinearGradient
          colors={FILL}
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
        <Text style={styles.label} numberOfLines={1}>{label}</Text>
      </View>
    </TouchableOpacity>
  );
}

// White in every display mode — owner's call, and fixed rather than themed so
// the label can't flip to dark ink on the light theme. It sits on the wordmark
// yellow, so this is a low-contrast pairing by design; the word is short, bold
// and 14pt, which is what carries it.
const LABEL = '#FFFFFF';

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  // Fill comes from the FILL gradient above; the background colour is only a
  // fallback for the frame before the gradient paints.
  btn: {
    flexDirection: 'row', alignItems: 'center',
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
  // Back to normal typography now the outline is gone: 800 and 0.2. The loose
  // 700/0.8 existed only to stop neighbouring outlines welding together, and
  // without a ring to accommodate it just read as a gappy word.
  label: { color: LABEL, fontSize: 14, fontWeight: '800', letterSpacing: 0.2 },
});
