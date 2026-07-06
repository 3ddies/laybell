import { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { RADIUS, SPACING, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { tabTick } from '../lib/haptics';

// The celebratory "Your post is in the Spotlight!" moment — replaces the stock
// system alert. Same fade+scale entrance as ConfirmDialog, but staged like the
// Spotlight landing: a lit disc with a beam glow, headline, and one gradient CTA.

export default function SpotlightLiveDialog({
  visible,
  duration,
  onClose,
}: {
  visible: boolean;
  /** Mid-sentence duration phrase, e.g. "day" / "3 days" (spotlightDurationPhrase). */
  duration: string;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const fade = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.9)).current;

  useEffect(() => {
    if (visible) {
      tabTick(); // celebratory entrance gets a physical tick too
      fade.setValue(0);
      scale.setValue(0.9);
      Animated.parallel([
        Animated.timing(fade, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.spring(scale, { toValue: 1, friction: 7, tension: 90, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, fade, scale]);

  if (!visible) return null;

  return (
    <Animated.View style={[styles.backdrop, { opacity: fade }]}>
      <Animated.View style={[styles.card, { transform: [{ scale }] }]}>
        {/* Lit spotlight disc */}
        <View style={styles.discGlow}>
          <LinearGradient
            colors={[colors.primary, colors.primaryDark ?? colors.primary]}
            style={styles.disc}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
          >
            <Ionicons name="sparkles" size={30} color="#fff" />
          </LinearGradient>
        </View>

        <Text style={styles.title}>{t('spotlight.liveTitle')}</Text>
        <Text style={styles.body}>{t('spotlight.liveBody', { duration })}</Text>

        <TouchableOpacity style={styles.cta} onPress={onClose} activeOpacity={0.85}>
          <LinearGradient
            colors={[colors.primary, colors.primaryDark ?? colors.primary]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.ctaInner}
          >
            <Text style={styles.ctaText}>{t('spotlight.liveDone')}</Text>
          </LinearGradient>
        </TouchableOpacity>
      </Animated.View>
    </Animated.View>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.lg,
    zIndex: 60,
  },
  card: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: c.surfaceElevated,
    borderRadius: RADIUS.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    padding: SPACING.lg,
    alignItems: 'center',
    gap: SPACING.sm,
  },
  // Soft primary-tinted halo behind the disc — the "beam" pooling on it.
  discGlow: {
    width: 92,
    height: 92,
    borderRadius: 46,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(242,101,34,0.16)',
    marginBottom: 2,
  },
  disc: {
    width: 68,
    height: 68,
    borderRadius: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    color: c.text,
    fontSize: 19,
    fontWeight: '800',
    textAlign: 'center',
    letterSpacing: -0.3,
  },
  body: {
    color: c.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  cta: { alignSelf: 'stretch', borderRadius: RADIUS.full, overflow: 'hidden', marginTop: SPACING.sm },
  ctaInner: { alignItems: 'center', paddingVertical: 13 },
  ctaText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
