import { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RADIUS, SPACING, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { notifySuccess } from '../lib/haptics';
import { fmtCents } from '../lib/donations';

// Post-stream "You Earned $X" celebration. Shown when a host ends a broadcast
// that made money — a full-screen green moment with a shortcut straight to the
// Wallet to cash out. Dismiss returns the host to where End took them.

// One definition of money-green, in the theme. This pair was written out by
// hand in three files; the tip alert becoming green made that a fourth, which
// is one more than any colour should be able to drift in.
const GREEN = GRADIENTS.money;

export default function LiveEarnedOverlay({ amountCents, onCashOut, onDone }: {
  amountCents: number;
  onCashOut: () => void;
  onDone: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    notifySuccess();
    Animated.spring(anim, { toValue: 1, useNativeDriver: true, bounciness: 10, speed: 10 }).start();
  }, [anim]);

  return (
    <View style={[StyleSheet.absoluteFill, styles.root]}>
      <LinearGradient colors={GREEN} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      <Animated.View
        style={[
          styles.inner,
          {
            paddingBottom: insets.bottom + SPACING.xl,
            opacity: anim,
            transform: [
              { scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }) },
              { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) },
            ],
          },
        ]}
      >
        <View style={styles.badge}>
          <Ionicons name="cash" size={44} color="#fff" />
        </View>
        <Text style={styles.label}>{t('live.earned.title')}</Text>
        <Text style={styles.amount}>{fmtCents(amountCents)}</Text>
        <Text style={styles.sub}>{t('live.earned.sub')}</Text>

        <TouchableOpacity style={styles.cashBtn} onPress={onCashOut} activeOpacity={0.9}>
          <Ionicons name="arrow-up-circle" size={19} color={GREEN[1]} />
          <Text style={styles.cashText}>{t('live.earned.cashOut')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.doneBtn} onPress={onDone} hitSlop={8}>
          <Text style={styles.doneText}>{t('live.earned.done')}</Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const makeStyles = (_c: ThemePalette) => StyleSheet.create({
  root: { alignItems: 'center', justifyContent: 'center', zIndex: 200 },
  inner: { alignItems: 'center', paddingHorizontal: SPACING.xl, gap: 6 },
  badge: {
    width: 92, height: 92, borderRadius: 46, marginBottom: SPACING.md,
    backgroundColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center',
  },
  label: { color: 'rgba(255,255,255,0.92)', fontSize: 16, fontWeight: '700', letterSpacing: 0.3 },
  amount: { color: '#fff', fontSize: 56, fontWeight: '900', letterSpacing: -1.5 },
  sub: { color: 'rgba(255,255,255,0.9)', fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: SPACING.xl, paddingHorizontal: SPACING.lg },
  cashBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: '#fff', borderRadius: RADIUS.full, paddingVertical: 15, paddingHorizontal: 40, alignSelf: 'stretch',
  },
  cashText: { color: GREEN[1], fontSize: 16, fontWeight: '800' },
  doneBtn: { paddingVertical: 14 },
  doneText: { color: 'rgba(255,255,255,0.9)', fontSize: 14, fontWeight: '600' },
});
