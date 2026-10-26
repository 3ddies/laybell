import { memo, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Pressable, Animated, Easing } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, RADIUS, SHADOWS } from '../constants/theme';
import { useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

type IconName = keyof typeof Ionicons.glyphMap;

// One reusable feed promo "poster" for discovering a Laybell feature (Badges, Ads,
// Spotlight, …). A 1:1 square, everything centred, the whole card a button. A feed
// sentinel like ShopCard — not a post and not an ad, so it never touches the ad
// cadence. Two native-driven animations (entrance stagger + a looping breathe) so
// every promo card feels like a sibling of the shop card.
//
// TWO LOOKS from one component:
//   • gradient — `fill` two-colour wash, white ink, white CTA pill (its text the
//     fill's lead colour). Badges (icy blue), Spotlight (purple), etc.
//   • mono     — a WHITE card with a hairline, BLACK ink, and an inverted black CTA
//     pill. The Ads card: a clean, newspaper-ad look that stands apart from the
//     colour cards. Fixed white/black in both themes (the hairline keeps it legible
//     on the light theme's off-white paper).
export type PromoCardProps = {
  onPress: () => void;
  /** Main glyph in the circle. */
  icon: IconName;
  /** Two faint background motifs: [big, small]. */
  motifs: readonly [IconName, IconName];
  titleKey: string;
  subKey: string;
  ctaKey: string;
  /** Gradient wash (ignored when `mono`). */
  fill?: readonly [string, string];
  /** White-card / black-ink variant (the Ads card). */
  mono?: boolean;
};

function PromoCardBase({ onPress, icon, motifs, titleKey, subKey, ctaKey, fill = ['#000', '#000'], mono = false }: PromoCardProps) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();

  const ink = mono ? '#111111' : '#FFFFFF';
  const subInk = mono ? 'rgba(17,17,17,0.66)' : 'rgba(255,255,255,0.92)';
  const motifInk = mono ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.12)';
  const circleBg = mono ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.22)';
  const circleBorder = mono ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.4)';
  const ctaBg = mono ? '#111111' : '#FFFFFF';
  const ctaInk = mono ? '#FFFFFF' : fill[0];

  const enter = useRef(new Animated.Value(0)).current;
  const loop = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(enter, { toValue: 1, duration: 650, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    const breathe = Animated.loop(Animated.sequence([
      Animated.timing(loop, { toValue: 1, duration: 1300, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(loop, { toValue: 0, duration: 1300, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    breathe.start();
    return () => breathe.stop();
  }, [enter, loop]);

  const fade = (from: number, to: number) => enter.interpolate({ inputRange: [from, to], outputRange: [0, 1], extrapolate: 'clamp' });
  const rise = (from: number, to: number) => enter.interpolate({ inputRange: [from, to], outputRange: [24, 0], extrapolate: 'clamp' });
  const popIn = (from: number, to: number) => enter.interpolate({ inputRange: [from, to], outputRange: [0.9, 1], extrapolate: 'clamp' });
  const iconScaleIn = enter.interpolate({ inputRange: [0, 0.5], outputRange: [0.55, 1], extrapolate: 'clamp' });
  const iconPulse = loop.interpolate({ inputRange: [0, 1], outputRange: [1, 1.1] });
  const iconBob = loop.interpolate({ inputRange: [0, 1], outputRange: [0, -6] });
  const ctaPulse = loop.interpolate({ inputRange: [0, 1], outputRange: [1, 1.07] });
  const motif1Spin = loop.interpolate({ inputRange: [0, 1], outputRange: ['6deg', '-6deg'] });
  const motif2Spin = loop.interpolate({ inputRange: [0, 1], outputRange: ['-16deg', '-4deg'] });

  const body = (
    <>
      <Animated.View style={[styles.bgMotif1, { transform: [{ rotate: motif1Spin }] }]} pointerEvents="none">
        <Ionicons name={motifs[0]} size={200} color={motifInk} />
      </Animated.View>
      <Animated.View style={[styles.bgMotif2, { transform: [{ rotate: motif2Spin }] }]} pointerEvents="none">
        <Ionicons name={motifs[1]} size={116} color={motifInk} />
      </Animated.View>

      <Animated.View style={[styles.iconCircle, { backgroundColor: circleBg, borderColor: circleBorder }, { opacity: fade(0, 0.5), transform: [{ translateY: rise(0, 0.5) }, { translateY: iconBob }, { scale: iconScaleIn }, { scale: iconPulse }] }]}>
        <Ionicons name={icon} size={34} color={ink} />
      </Animated.View>

      <Animated.Text style={[styles.title, { color: ink }, { opacity: fade(0.15, 0.65), transform: [{ translateY: rise(0.15, 0.65) }, { scale: popIn(0.15, 0.65) }] }]} numberOfLines={2}>
        {t(titleKey)}
      </Animated.Text>
      <Animated.Text style={[styles.sub, { color: subInk }, { opacity: fade(0.3, 0.8), transform: [{ translateY: rise(0.3, 0.8) }, { scale: popIn(0.3, 0.8) }] }]} numberOfLines={3}>
        {t(subKey)}
      </Animated.Text>

      <Animated.View style={[styles.cta, { backgroundColor: ctaBg }, { opacity: fade(0.45, 0.95), transform: [{ translateY: rise(0.45, 0.95) }, { scale: popIn(0.45, 0.95) }, { scale: ctaPulse }] }]}>
        <Text style={[styles.ctaText, { color: ctaInk }]}>{t(ctaKey)}</Text>
        <Ionicons name="arrow-forward" size={16} color={ctaInk} />
      </Animated.View>
    </>
  );

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${t(titleKey)}. ${t(ctaKey)}`}
        style={({ pressed }) => (pressed ? styles.pressed : undefined)}
      >
        {mono ? (
          <View style={[styles.card, styles.mono]}>{body}</View>
        ) : (
          <LinearGradient colors={fill} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.card}>{body}</LinearGradient>
        )}
      </Pressable>
    </View>
  );
}

export default memo(PromoCardBase);

const makeStyles = () => StyleSheet.create({
  wrap: { paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm },
  pressed: { opacity: 0.94, transform: [{ scale: 0.99 }] },
  // 1:1 square, everything centred — same footprint as the shop card.
  card: {
    aspectRatio: 1, borderRadius: RADIUS.xl, padding: SPACING.lg,
    overflow: 'hidden', alignItems: 'center', justifyContent: 'center', ...SHADOWS.md,
  },
  // White card for the mono (Ads) variant; the hairline keeps it off the light paper.
  mono: { backgroundColor: '#FFFFFF', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(0,0,0,0.14)' },
  bgMotif1: { position: 'absolute', right: -30, top: -36 },
  bgMotif2: { position: 'absolute', left: 28, bottom: 64 },
  iconCircle: {
    width: 76, height: 76, borderRadius: 38, marginBottom: SPACING.md,
    alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 30, fontWeight: '900', textAlign: 'center', letterSpacing: 0.3 },
  sub: { fontSize: 15, fontWeight: '600', textAlign: 'center', lineHeight: 20, marginTop: 6, maxWidth: '88%' },
  cta: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: SPACING.md,
    borderRadius: RADIUS.full, paddingHorizontal: SPACING.md + 4, paddingVertical: 11,
  },
  ctaText: { fontSize: 15, fontWeight: '800' },
});
