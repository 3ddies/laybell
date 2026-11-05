import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import SwipeBackPager from '../components/SwipeBackPager';
import { FlipNumber } from '../components/RollingNumber';
import { useLifetimeStats } from '../lib/useLifetimeStats';
import { SPACING, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

// The notifications stats header, expanded: the three lifetime numbers in full (with
// separators) and large, flipping to new values as engagement comes in. Same live
// polling as the header (useLifetimeStats) so the two stay in lockstep.
export default function LifetimeStatsScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const router = useRouter();
  const stats = useLifetimeStats();

  const rows = [
    { key: 'views', value: stats?.views ?? 0, label: t('notifications.statViews') },
    { key: 'plays', value: stats?.plays ?? 0, label: t('notifications.statPlays') },
    { key: 'likes', value: stats?.likes ?? 0, label: t('notifications.statLikes') },
  ];

  return (
    <SwipeBackPager>
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.backBtn} onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('analytics.lifetime')}</Text>
          <View style={{ width: 40 }} />
        </View>

        <View style={styles.body}>
          {rows.map((r) => (
            <View key={r.key} style={styles.block}>
              <FlipNumber value={r.value} fontSize={46} color={colors.text} />
              <Text style={styles.label}>{r.label}</Text>
            </View>
          ))}
          <View style={styles.liveRow}>
            <View style={styles.liveDot} />
            <Text style={styles.liveText}>{t('lifetimeStats.live')}</Text>
          </View>
        </View>
      </View>
    </SwipeBackPager>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.borderSubtle,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.xxl },
  block: { alignItems: 'center', gap: SPACING.xs },
  label: { color: colors.textTertiary, fontSize: 13, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1 },
  liveRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: SPACING.lg },
  liveDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: '#22C55E' },
  liveText: { color: colors.textTertiary, fontSize: 12, fontWeight: '600' },
});
