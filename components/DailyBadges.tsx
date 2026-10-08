import { memo, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { fetchBadgeState, computeMetrics, type BadgeMetrics } from '../lib/badges';

// The day's badge goals (each maps to a "today" badge category: daily likes, music
// streaming, comments, Spotlight engagement). Entry-tier targets, so finishing all
// four is a realistic daily checklist.
type Goal = { id: string; icon: keyof typeof Ionicons.glyphMap; value: (m: BadgeMetrics) => number; target: number };
const GOALS: Goal[] = [
  { id: 'like', icon: 'heart', value: (m) => m.todayLikes, target: 10 },
  { id: 'music', icon: 'musical-notes', value: (m) => m.musicMinutesToday, target: 10 },
  { id: 'comment', icon: 'chatbubble-ellipses', value: (m) => m.todayComments, target: 1 },
  { id: 'spotlight', icon: 'flame', value: (m) => m.todayAdEngagements, target: 1 },
];

// Shown on the signed-in user's OWN profile once the account-setup checklist is
// complete (see ProfileCompletion): the next TODO list — the day's badge goals and
// progress. Loads its own metrics because ProfileContext doesn't surface them.
function DailyBadgesBase({ onSeeAll }: { onSeeAll: () => void }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const [metrics, setMetrics] = useState<BadgeMetrics | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await fetchBadgeState();
        if (alive && s) setMetrics(computeMetrics(s));
      } catch {}
    })();
    return () => { alive = false; };
  }, []);

  const done = metrics ? GOALS.filter((g) => g.value(metrics) >= g.target).length : 0;
  const pct = done / GOALS.length;

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={styles.title}>{t('dailyBadges.title')}</Text>
          <Text style={styles.sub}>{t('dailyBadges.sub')}</Text>
        </View>
        <Text style={styles.count}>{t('dailyBadges.progress', { done, total: GOALS.length })}</Text>
      </View>

      <View style={styles.track}>
        <LinearGradient colors={GRADIENTS.primaryWarm as any} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={[styles.fill, { width: `${Math.round(pct * 100)}%` }]} />
      </View>

      {!metrics ? (
        <View style={styles.loading}><ActivityIndicator color={colors.background} /></View>
      ) : (
        <View style={styles.rows}>
          {GOALS.map((g) => {
            const cur = g.value(metrics);
            const complete = cur >= g.target;
            return (
              <View key={g.id} style={styles.row}>
                <View style={[styles.rowIcon, complete && styles.rowIconDone]}>
                  <Ionicons name={complete ? 'checkmark' : g.icon} size={17} color={complete ? '#fff' : colors.background} />
                </View>
                <Text style={styles.rowLabel} numberOfLines={1}>{t(`dailyBadges.goal.${g.id}`)}</Text>
                <Text style={[styles.rowCount, complete && styles.rowCountDone]}>{Math.min(cur, g.target)}/{g.target}</Text>
              </View>
            );
          })}
        </View>
      )}

      <TouchableOpacity style={styles.seeAll} onPress={onSeeAll} activeOpacity={0.7} accessibilityRole="button">
        <Text style={styles.seeAllText}>{t('dailyBadges.seeAll')}</Text>
        <Ionicons name="chevron-forward" size={15} color={colors.background} />
      </TouchableOpacity>
    </View>
  );
}

export default memo(DailyBadgesBase);

// Inverted card (fill = colors.text), to match ProfileCompletion — all inner content
// uses colors.background so it reads against the flipped fill in either theme.
const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  wrap: {
    backgroundColor: colors.text, borderRadius: RADIUS.lg, overflow: 'hidden',
    marginHorizontal: SPACING.md, marginBottom: SPACING.md, padding: SPACING.md,
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.sm },
  headText: { flex: 1 },
  title: { color: colors.background, fontSize: 16, fontWeight: '800' },
  sub: { color: colors.background, opacity: 0.7, fontSize: 12.5, marginTop: 1 },
  count: { color: colors.background, opacity: 0.85, fontSize: 12.5, fontWeight: '700' },
  track: { height: 5, borderRadius: 3, backgroundColor: colors.background + '26', overflow: 'hidden', marginTop: SPACING.sm },
  fill: { height: '100%', borderRadius: 3 },
  loading: { paddingVertical: SPACING.lg, alignItems: 'center' },
  rows: { marginTop: SPACING.md, gap: SPACING.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  rowIcon: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background + '1F' },
  rowIconDone: { backgroundColor: colors.success },
  rowLabel: { flex: 1, color: colors.background, fontSize: 14, fontWeight: '600' },
  rowCount: { color: colors.background, opacity: 0.7, fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] },
  rowCountDone: { color: colors.success, opacity: 1 },
  seeAll: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 2,
    marginTop: SPACING.md, paddingTop: SPACING.sm,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.background + '26',
  },
  seeAllText: { color: colors.background, fontSize: 13, fontWeight: '700' },
});
