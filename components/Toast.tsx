import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';

type Props = {
  visible: boolean;
  title: string;
  message?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  /** Auto-dismiss delay in ms. */
  duration?: number;
  /** Extra lift above the safe-area inset — clears a bottom bar when present. */
  bottomOffset?: number;
  onHide: () => void;
};

// Lightweight confirmation toast: a card that springs up from the bottom and
// auto-dismisses. Self-contained (no provider) — render it where you need it and
// drive `visible`. Matches the elevated-card look of BadgeUpgradeToast.
export default function Toast({
  visible,
  title,
  message,
  icon = 'checkmark-circle',
  duration = 2600,
  bottomOffset = SPACING.xl,
  onHide,
}: Props) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const anim = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!visible) return;
    anim.setValue(0);
    Animated.spring(anim, { toValue: 1, useNativeDriver: true, friction: 9, tension: 60 }).start();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(hide, duration);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  function hide() {
    Animated.timing(anim, { toValue: 0, duration: 200, useNativeDriver: true }).start(({ finished }) => {
      if (finished) onHide();
    });
  }

  if (!visible) return null;
  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [40, 0] });

  return (
    // pointerEvents none so the toast never swallows taps meant for the UI behind it.
    <Animated.View
      pointerEvents="none"
      style={[styles.wrap, { bottom: insets.bottom + bottomOffset, opacity: anim, transform: [{ translateY }] }]}
    >
      <View style={styles.card}>
        <Ionicons name={icon} size={22} color={colors.primary} />
        <View style={styles.body}>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          {!!message && <Text style={styles.message} numberOfLines={2}>{message}</Text>}
        </View>
      </View>
    </Animated.View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  wrap: { position: 'absolute', left: SPACING.md, right: SPACING.md, zIndex: 1000 },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm + 2,
    backgroundColor: colors.surfaceElevated, borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: colors.border,
    paddingVertical: SPACING.sm + 4, paddingHorizontal: SPACING.md,
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 14, shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  body: { flex: 1 },
  title: { color: colors.text, fontSize: 14.5, fontWeight: '800', letterSpacing: -0.2 },
  message: { color: colors.textSecondary, fontSize: 12.5, marginTop: 1, lineHeight: 17 },
});
