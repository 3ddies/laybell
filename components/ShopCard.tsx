import { memo, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Pressable, Animated, Easing } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, RADIUS, SHADOWS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

// A friendly, always-present promo card injected ONCE into the Home feed: tap it to
// open the shop and browse beats, songs and more to buy. It is a feed sentinel (like
// PeopleRow), not a post and not an ad, so it never touches the ad cadence. Laid out
// as a 1:1 square "poster" with everything centred. The whole card is the button.
//
// Two animations (all native-driven, so the JS thread stays free while scrolling):
//   • enter — a one-shot staggered fade + rise as the card scrolls into view.
//   • loop  — a gentle, continuous breathing (badge + CTA pulse, motifs drift) that
//             keeps the card feeling alive in the feed.
function ShopCardBase({ onPress }: { onPress: () => void }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();

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

  // Each element fades + rises over its own slice of the entrance timeline (stagger).
  const fade = (from: number, to: number) => enter.interpolate({ inputRange: [from, to], outputRange: [0, 1], extrapolate: 'clamp' });
  const rise = (from: number, to: number) => enter.interpolate({ inputRange: [from, to], outputRange: [24, 0], extrapolate: 'clamp' });
  const popIn = (from: number, to: number) => enter.interpolate({ inputRange: [from, to], outputRange: [0.9, 1], extrapolate: 'clamp' });
  const iconScaleIn = enter.interpolate({ inputRange: [0, 0.5], outputRange: [0.55, 1], extrapolate: 'clamp' });
  const iconPulse = loop.interpolate({ inputRange: [0, 1], outputRange: [1, 1.1] });
  const iconBob = loop.interpolate({ inputRange: [0, 1], outputRange: [0, -6] });
  const ctaPulse = loop.interpolate({ inputRange: [0, 1], outputRange: [1, 1.07] });
  const noteSpin = loop.interpolate({ inputRange: [0, 1], outputRange: ['5deg', '19deg'] });
  const tagSpin = loop.interpolate({ inputRange: [0, 1], outputRange: ['-19deg', '-7deg'] });

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${t('shopCard.title')}. ${t('shopCard.cta')}`}
        style={({ pressed }) => (pressed ? styles.pressed : undefined)}
      >
        <LinearGradient
          colors={GRADIENTS.primaryWarm}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.card}
        >
          {/* Playful, faint background music notes + price tag — "music you can buy". */}
          <Animated.View style={[styles.bgNote, { transform: [{ rotate: noteSpin }] }]} pointerEvents="none">
            <Ionicons name="musical-notes" size={190} color="rgba(255,255,255,0.13)" />
          </Animated.View>
          <Animated.View style={[styles.bgTag, { transform: [{ rotate: tagSpin }] }]} pointerEvents="none">
            <Ionicons name="pricetag" size={120} color="rgba(255,255,255,0.10)" />
          </Animated.View>

          <Animated.View style={[styles.iconCircle, { opacity: fade(0, 0.5), transform: [{ translateY: rise(0, 0.5) }, { translateY: iconBob }, { scale: iconScaleIn }, { scale: iconPulse }] }]}>
            <Ionicons name="storefront" size={34} color="#fff" />
          </Animated.View>

          <Animated.Text style={[styles.title, { opacity: fade(0.15, 0.65), transform: [{ translateY: rise(0.15, 0.65) }, { scale: popIn(0.15, 0.65) }] }]} numberOfLines={2}>
            {t('shopCard.title')}
          </Animated.Text>
          <Animated.Text style={[styles.sub, { opacity: fade(0.3, 0.8), transform: [{ translateY: rise(0.3, 0.8) }, { scale: popIn(0.3, 0.8) }] }]} numberOfLines={3}>
            {t('shopCard.sub')}
          </Animated.Text>

          <Animated.View style={[styles.cta, { opacity: fade(0.45, 0.95), transform: [{ translateY: rise(0.45, 0.95) }, { scale: popIn(0.45, 0.95) }, { scale: ctaPulse }] }]}>
            <Text style={styles.ctaText}>{t('shopCard.cta')}</Text>
            <Ionicons name="arrow-forward" size={16} color={colors.primary} />
          </Animated.View>
        </LinearGradient>
      </Pressable>
    </View>
  );
}

export default memo(ShopCardBase);

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  wrap: { paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm },
  pressed: { opacity: 0.94, transform: [{ scale: 0.99 }] },
  // 1:1 square, everything centred.
  card: {
    aspectRatio: 1, borderRadius: RADIUS.xl, padding: SPACING.lg,
    overflow: 'hidden', alignItems: 'center', justifyContent: 'center', ...SHADOWS.md,
  },
  bgNote: { position: 'absolute', right: -26, top: -34 },
  bgTag: { position: 'absolute', right: 34, bottom: 70 },
  iconCircle: {
    width: 76, height: 76, borderRadius: 38, marginBottom: SPACING.md,
    backgroundColor: 'rgba(255,255,255,0.22)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.4)',
  },
  title: { color: '#fff', fontSize: 30, fontWeight: '900', textAlign: 'center', letterSpacing: 0.3 },
  sub: { color: 'rgba(255,255,255,0.92)', fontSize: 15, fontWeight: '600', textAlign: 'center', lineHeight: 20, marginTop: 6, maxWidth: '88%' },
  cta: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: SPACING.md,
    backgroundColor: '#fff', borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md + 4, paddingVertical: 11,
  },
  ctaText: { color: colors.primary, fontSize: 15, fontWeight: '800' },
});
