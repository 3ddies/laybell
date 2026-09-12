import { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Animated, Easing, Pressable } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';

// The moment a post goes up — or is scheduled: a card that lands with a small burst
// of confetti, the post itself, and where to go next (see it, share it, carry on).
// It replaced a toast that said "Posted!" and was gone before anyone could act on it.
//
// Only for a post that genuinely exists. A video is still uploading when Share is
// tapped, and celebrating a post that can yet fail is a promise the app cannot keep
// (see the note in the composer's video path), so videos keep their upload toast.
//
// Plain React Native Animated on the native driver: no new dependency.

export type Celebration = {
  postId: string;
  title: string;
  message: string;
  scheduled: boolean;
  spotlight?: boolean;
  thumb: string | null;
  /** For the share sheet. */
  caption?: string | null;
  type?: string | null;
  mediaUrl?: string | null;
};

const PIECES = 20;
const CONFETTI = ['#FAB525', '#F43F5E', '#22C55E', '#3B82F6', '#A855F7', '#F97316'];

export default function PostedCelebration({ celebration, onView, onShare, onClose }: {
  celebration: Celebration | null;
  onView: (c: Celebration) => void;
  onShare: (c: Celebration) => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const visible = !!celebration;
  // The card keeps what it showed through its exit.
  const shown = useRef<Celebration | null>(celebration);
  if (celebration) shown.current = celebration;
  const c = shown.current;

  const [mounted, setMounted] = useState(visible);
  const enter = useRef(new Animated.Value(0)).current;
  const burst = useRef(new Animated.Value(0)).current;

  // A ring of pieces thrown out from behind the badge, each with its own reach,
  // size and spin, then falling a little as they fade.
  const pieces = useMemo(() => Array.from({ length: PIECES }, (_, i) => {
    const angle = (i / PIECES) * Math.PI * 2 + (i % 2 ? 0.16 : -0.12);
    const reach = 96 + (i % 4) * 30;
    return {
      dx: Math.cos(angle) * reach,
      dy: Math.sin(angle) * reach * 0.8,
      color: CONFETTI[i % CONFETTI.length],
      size: 6 + (i % 3) * 2,
      round: i % 3 === 0,
      spin: `${(i % 2 ? 1 : -1) * (200 + i * 17)}deg`,
    };
  }), []);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      enter.setValue(0);
      burst.setValue(0);
      Animated.parallel([
        Animated.spring(enter, { toValue: 1, friction: 7, tension: 70, useNativeDriver: true }),
        Animated.timing(burst, { toValue: 1, duration: 1100, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]).start();
    } else if (mounted) {
      Animated.timing(enter, { toValue: 0, duration: 170, easing: Easing.in(Easing.cubic), useNativeDriver: true })
        .start(({ finished }) => { if (finished) setMounted(false); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!mounted || !c) return null;

  const scale = enter.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] });
  const pieceOpacity = burst.interpolate({ inputRange: [0, 0.08, 0.7, 1], outputRange: [0, 1, 1, 0] });

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={[styles.backdrop, { opacity: enter }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel={t('common.done')} />
        <Animated.View style={[styles.wrap, { transform: [{ scale }] }]} pointerEvents="box-none">
          <View style={styles.card}>
            {c.thumb ? (
              <ExpoImage source={{ uri: c.thumb }} style={styles.thumb} contentFit="cover" />
            ) : null}
            <Text style={styles.title} accessibilityRole="header">{c.title}</Text>
            <Text style={styles.message}>{c.message}</Text>

            <TouchableOpacity style={styles.primary} onPress={() => onView(c)} activeOpacity={0.85} accessibilityRole="button">
              <Ionicons name={c.scheduled ? 'calendar-outline' : 'eye-outline'} size={17} color={colors.background} />
              <Text style={styles.primaryText}>{c.scheduled ? t('celebrate.seeScheduled') : t('celebrate.viewPost')}</Text>
            </TouchableOpacity>
            {/* A scheduled post has nothing to share yet: its link opens nothing until it is live. */}
            {!c.scheduled && (
              <TouchableOpacity style={styles.secondary} onPress={() => onShare(c)} activeOpacity={0.85} accessibilityRole="button">
                <Ionicons name="share-outline" size={17} color={colors.text} />
                <Text style={styles.secondaryText}>{t('celebrate.share')}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.tertiary} onPress={onClose} hitSlop={8} accessibilityRole="button">
              <Text style={styles.tertiaryText}>{t('common.done')}</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.burst} pointerEvents="none">
            {pieces.map((p, i) => (
              <Animated.View
                key={i}
                style={[
                  styles.piece,
                  {
                    width: p.size,
                    height: p.round ? p.size : p.size * 1.8,
                    borderRadius: p.round ? p.size / 2 : 2,
                    backgroundColor: p.color,
                    opacity: pieceOpacity,
                    transform: [
                      { translateX: burst.interpolate({ inputRange: [0, 1], outputRange: [0, p.dx] }) },
                      { translateY: burst.interpolate({ inputRange: [0, 0.55, 1], outputRange: [0, p.dy, p.dy + 70] }) },
                      { rotate: burst.interpolate({ inputRange: [0, 1], outputRange: ['0deg', p.spin] }) },
                    ],
                  },
                ]}
              />
            ))}
          </View>
          <View style={[styles.badge, c.scheduled && styles.badgeScheduled]}>
            <Ionicons name={c.scheduled ? 'calendar' : c.spotlight ? 'sparkles' : 'checkmark'} size={30} color="#fff" />
          </View>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const BADGE = 64;

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: SPACING.lg },
  wrap: { width: '100%', maxWidth: 360, alignItems: 'center', paddingTop: BADGE / 2 },
  card: {
    width: '100%', alignItems: 'center', gap: SPACING.sm,
    paddingTop: BADGE / 2 + SPACING.md, paddingBottom: SPACING.md, paddingHorizontal: SPACING.lg,
    borderRadius: RADIUS.xl, backgroundColor: colors.surface,
  },
  badge: {
    position: 'absolute', top: 0, width: BADGE, height: BADGE, borderRadius: BADGE / 2,
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#22C55E',
    borderWidth: 4, borderColor: colors.surface,
  },
  badgeScheduled: { backgroundColor: '#3B82F6' },
  burst: { position: 'absolute', top: BADGE / 2, left: '50%', width: 0, height: 0 },
  piece: { position: 'absolute' },
  thumb: { width: 76, height: 76, borderRadius: RADIUS.md, backgroundColor: colors.surfaceLight, marginBottom: SPACING.xs },
  title: { color: colors.text, fontSize: 21, fontWeight: '800', textAlign: 'center' },
  message: { color: colors.textSecondary, fontSize: 14, lineHeight: 20, textAlign: 'center', marginBottom: SPACING.sm },
  primary: {
    alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 13, borderRadius: RADIUS.full, backgroundColor: colors.text,
  },
  primaryText: { color: colors.background, fontSize: 15, fontWeight: '800' },
  secondary: {
    alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 12, borderRadius: RADIUS.full, borderWidth: 1, borderColor: colors.border,
  },
  secondaryText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  tertiary: { paddingVertical: SPACING.sm },
  tertiaryText: { color: colors.textSecondary, fontSize: 14, fontWeight: '700' },
});
