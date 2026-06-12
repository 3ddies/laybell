import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { onBadgeTierUpgrade, tierLabel, badgeRingColors, type Tier } from '../lib/badges';
import BadgeEmblem from './BadgeEmblem';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';

// A celebratory banner that slides down from the top whenever the user levels up
// to a higher badge tier mid-session. Auto-dismisses; tap to open the Badges page.
// Mounted once at the app root so it fires from anywhere a badge is earned.
export default function BadgeUpgradeToast() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [tier, setTier] = useState<Tier | null>(null);
  const y = useRef(new Animated.Value(-200)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => onBadgeTierUpgrade((t) => setTier(t)), []);

  useEffect(() => {
    if (!tier) return;
    y.setValue(-200);
    Animated.spring(y, { toValue: 0, useNativeDriver: true, friction: 8, tension: 55 }).start();
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(dismiss, 5000);
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier]);

  function dismiss() {
    Animated.timing(y, { toValue: -200, duration: 250, useNativeDriver: true }).start(() => setTier(null));
  }

  if (!tier) return null;
  const accent = badgeRingColors(tier)[0];

  return (
    <Animated.View
      style={[styles.wrap, { paddingTop: insets.top + SPACING.sm, transform: [{ translateY: y }] }]}
      pointerEvents="box-none"
    >
      <TouchableOpacity
        activeOpacity={0.9}
        style={[styles.card, { borderColor: accent + '55' }]}
        onPress={() => { dismiss(); router.push('/badges'); }}
      >
        <BadgeEmblem tier={tier} size={36} />
        <View style={styles.body}>
          <Text style={styles.title}>Badge upgraded!</Text>
          <Text style={styles.sub} numberOfLines={1}>You reached <Text style={{ color: accent, fontWeight: '800' }}>{tierLabel(tier)}</Text> status — tap to view</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
      </TouchableOpacity>
    </Animated.View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  wrap: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1000,
    paddingHorizontal: SPACING.md,
  },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm + 2,
    backgroundColor: colors.surfaceElevated,
    borderRadius: RADIUS.lg, borderWidth: 1,
    paddingVertical: SPACING.sm + 2, paddingHorizontal: SPACING.md,
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 14, shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  body: { flex: 1 },
  title: { color: colors.text, fontSize: 15, fontWeight: '800', letterSpacing: -0.2 },
  sub: { color: colors.textSecondary, fontSize: 12.5, marginTop: 1 },
});
