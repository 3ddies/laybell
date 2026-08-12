import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, Image, RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState, useCallback } from 'react';
import SwipeBackPager from '../components/SwipeBackPager';
import { supabase } from '../lib/supabase';
import {
  fetchCreatorAnalytics, buildSeries, countInRange, hourLabel, dayLabel,
  type CreatorAnalytics, type RangeMode,
} from '../lib/analytics';
import { BarChart, HBars } from '../components/AnalyticsCharts';
import { formatCount } from '../lib/format';
import { countLabel } from '../lib/i18n';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { AnalyticsSkeleton } from '../components/Skeleton';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

const RANGES: { key: RangeMode; labelKey: string }[] = [
  { key: '7d', labelKey: 'analytics.range7d' },
  { key: '30d', labelKey: 'analytics.range30d' },
  { key: '90d', labelKey: 'analytics.range90d' },
  { key: 'all', labelKey: 'analytics.rangeAll' },
];

const WD_KEYS = [
  'analytics.wdSun', 'analytics.wdMon', 'analytics.wdTue', 'analytics.wdWed',
  'analytics.wdThu', 'analytics.wdFri', 'analytics.wdSat',
];

function typeLabel(t: Translate, type: string): string {
  switch (type) {
    case 'image': return t('analytics.typePhotos');
    case 'video': return t('analytics.typeVideos');
    case 'audio': return t('analytics.typeMusic');
    case 'podcast': return t('analytics.typePodcasts');
    case 'audiobook': return t('analytics.typeAudiobooks');
    default: return type.charAt(0).toUpperCase() + type.slice(1);
  }
}
function shortHour(i: number): string {
  return `${i % 12 === 0 ? 12 : i % 12}${i < 12 ? 'a' : 'p'}`;
}

function StatCard({ icon, value, label, tint }: { icon: any; value: string; label: string; tint?: string }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.statCard}>
      <Ionicons name={icon} size={16} color={tint ?? colors.primary} />
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {!!subtitle && <Text style={styles.sectionSubtitle}>{subtitle}</Text>}
      <View style={styles.card}>{children}</View>
    </View>
  );
}

export default function AnalyticsScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const router = useRouter();
  const [data, setData] = useState<CreatorAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [range, setRange] = useState<RangeMode>('30d');
  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); setRefreshing(false); return; }
    try {
      setData(await fetchCreatorAnalytics(user.id));
    } catch {
      setData(null);
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    // Swipe right anywhere to slide the whole page (header included) off and
    // reveal the screen underneath — one motion, same feel as the tab pager.
    <SwipeBackPager>
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('account.analytics')}</Text>
        <View style={{ width: 40 }} />
      </View>

          {loading ? (
            <View style={{ flex: 1 }}><AnalyticsSkeleton /></View>
          ) : !data || data.totals.posts === 0 ? (
            <View style={styles.center}>
              <Ionicons name="bar-chart-outline" size={44} color={colors.textTertiary} />
              <Text style={styles.emptyTitle}>{t('analytics.emptyTitle')}</Text>
              <Text style={styles.emptySub}>{t('analytics.emptySub')}</Text>
            </View>
          ) : (
            <Analytics data={data} range={range} setRange={setRange} refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />
          )}
    </View>
    </SwipeBackPager>
  );
}

function Analytics({
  data, range, setRange, refreshing, onRefresh,
}: {
  data: CreatorAnalytics; range: RangeMode; setRange: (r: RangeMode) => void;
  refreshing: boolean; onRefresh: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { totals } = data;
  const followerSeries = buildSeries(data.followerTs, range);
  const engagementSeries = buildSeries(data.engagementTs, range);
  const newFollowers = countInRange(data.followerTs, range);
  const engagementInRange = countInRange(data.engagementTs, range);

  const dayData = data.byDay.map((v, i) => ({ label: t(WD_KEYS[i]), value: v }));
  const hourData = data.byHour.map((v, i) => ({ label: shortHour(i), value: v }));

  const mixData = data.contentMix.map((m) => ({
    label: typeLabel(t, m.type), value: m.count, caption: countLabel('post', m.count),
  }));
  const bestType = [...data.contentMix].filter((m) => m.count > 0).sort((a, b) => b.avgEngagement - a.avgEngagement)[0];

  const rangeWord = range === 'all' ? t('analytics.rangeWordYear')
    : range === '7d' ? t('analytics.rangeWordWeek')
    : range === '30d' ? t('analytics.rangeWordMonth')
    : t('analytics.rangeWord90d');

  return (
    <ScrollView
      contentContainerStyle={styles.scroll}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      {/* Lifetime overview */}
      <Text style={styles.overviewLabel}>{t('analytics.lifetime')}</Text>
      <View style={styles.statGrid}>
        <StatCard icon="people" value={formatCount(totals.followers)} label={t('profile.followers')} />
        <StatCard icon="grid" value={formatCount(totals.posts)} label={t('analytics.posts')} />
        <StatCard icon="heart" value={formatCount(totals.likes)} label={t('analytics.likes')} tint={colors.like} />
        <StatCard icon="chatbubble" value={formatCount(totals.comments)} label={t('analytics.comments')} />
        <StatCard icon="bookmark" value={formatCount(totals.saves)} label={t('analytics.saves')} />
        <StatCard icon="play" value={formatCount(totals.views)} label={t('analytics.viewsPlays')} />
      </View>

      {/* Engagement rate highlight */}
      <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.rateCard}>
        <View style={{ flex: 1 }}>
          <Text style={styles.rateValue}>{data.engagementRate.toFixed(1)}</Text>
          <Text style={styles.rateLabel}>{t('analytics.avgEngagementPerPost')}</Text>
        </View>
        <View style={styles.rateRight}>
          <Text style={styles.rateSmall}>{countLabel('share', totals.shares)}</Text>
          <Text style={styles.rateSmall}>{countLabel('following', totals.following)}</Text>
        </View>
      </LinearGradient>

      {/* Range toggle */}
      <View style={styles.rangeRow}>
        {RANGES.map((r) => (
          <TouchableOpacity
            key={r.key}
            style={[styles.rangeBtn, range === r.key && styles.rangeBtnActive]}
            onPress={() => setRange(r.key)}
          >
            <Text style={[styles.rangeText, range === r.key && styles.rangeTextActive]}>{t(r.labelKey)}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Follower growth */}
      <Section
        title={t('analytics.newFollowers')}
        subtitle={t('analytics.newFollowersSub', {
          change: `${newFollowers >= 0 ? '+' : ''}${formatCount(newFollowers)}`,
          range: rangeWord,
        })}
      >
        <BarChart data={followerSeries} />
      </Section>

      {/* Engagement over time */}
      <Section
        title={t('analytics.engagementReceived')}
        subtitle={t('analytics.engagementSub', { count: formatCount(engagementInRange), range: rangeWord })}
      >
        <BarChart data={engagementSeries} />
      </Section>

      {/* Best times */}
      <Section
        title={t('analytics.audienceActive')}
        subtitle={
          data.peakDay != null && data.peakHour != null
            ? t('analytics.peakSub', { day: dayLabel(data.peakDay), hour: hourLabel(data.peakHour) })
            : t('analytics.peakSubEmpty')
        }
      >
        <Text style={styles.chartHint}>{t('analytics.byDayOfWeek')}</Text>
        <BarChart data={dayData} height={110} />
        <View style={styles.innerDivider} />
        <Text style={styles.chartHint}>{t('analytics.byHourOfDay')}</Text>
        <BarChart data={hourData} height={110} />
      </Section>

      {/* Content performance */}
      {mixData.length > 0 && (
        <Section
          title={t('analytics.contentMix')}
          subtitle={bestType ? t('analytics.mixSub', { type: typeLabel(t, bestType.type).toLowerCase(), avg: bestType.avgEngagement.toFixed(1) }) : undefined}
        >
          <HBars data={mixData} accentTop />
        </Section>
      )}

      {/* Top posts */}
      {data.topPosts.length > 0 && (
        <Section title={t('analytics.topPosts')} subtitle={t('analytics.topPostsSub')}>
          <View style={{ gap: SPACING.sm }}>
            {data.topPosts.map((p, i) => (
              <View key={p.id} style={styles.topRow}>
                <Text style={styles.topRank}>{i + 1}</Text>
                {p.thumb ? (
                  <Image source={{ uri: p.thumb }} style={styles.topThumb} />
                ) : (
                  <LinearGradient colors={GRADIENTS.primarySoft} style={styles.topThumb}>
                    <Ionicons name={p.type === 'video' ? 'videocam' : p.type === 'image' ? 'image' : 'musical-notes'} size={18} color={colors.primary} />
                  </LinearGradient>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.topCaption} numberOfLines={1}>{p.caption || typeLabel(t, p.type)}</Text>
                  <View style={styles.topStats}>
                    <Ionicons name="heart" size={11} color={colors.like} />
                    <Text style={styles.topStat}>{formatCount(p.likes)}</Text>
                    <Ionicons name="chatbubble" size={11} color={colors.textTertiary} />
                    <Text style={styles.topStat}>{formatCount(p.comments)}</Text>
                    <Ionicons name="bookmark" size={11} color={colors.textTertiary} />
                    <Text style={styles.topStat}>{formatCount(p.saves)}</Text>
                    {p.views > 0 && (<><Ionicons name="play" size={11} color={colors.textTertiary} /><Text style={styles.topStat}>{formatCount(p.views)}</Text></>)}
                  </View>
                </View>
              </View>
            ))}
          </View>
        </Section>
      )}

      <Text style={styles.footnote}>{t('analytics.footnote')}</Text>
    </ScrollView>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACING.xl, gap: SPACING.sm },
  emptyTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  emptySub: { color: colors.textSecondary, fontSize: 13, textAlign: 'center', lineHeight: 19 },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm,
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },

  scroll: { padding: SPACING.md, paddingBottom: SPACING.xxl + SPACING.lg, gap: SPACING.md },

  overviewLabel: {
    color: colors.textTertiary, fontSize: 11, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.8, paddingHorizontal: SPACING.xs,
  },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  statCard: {
    width: '31.5%', flexGrow: 1,
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: colors.border,
    padding: SPACING.md, gap: 3,
  },
  statValue: { color: colors.text, fontSize: 20, fontWeight: '800', marginTop: 4 },
  statLabel: { color: colors.textSecondary, fontSize: 12 },

  rateCard: {
    flexDirection: 'row', alignItems: 'center',
    borderRadius: RADIUS.lg, borderWidth: 1, borderColor: colors.border,
    padding: SPACING.md,
  },
  rateValue: { color: colors.primaryLight, fontSize: 30, fontWeight: '800' },
  // Same rule as the post view's audio card: rateCard is a fixed dark gradient
  // in both themes, so theme text tokens vanish on it in light mode.
  rateLabel: { color: 'rgba(255,255,255,0.72)', fontSize: 13, marginTop: 2 },
  rateRight: { alignItems: 'flex-end', gap: 4 },
  rateSmall: { color: 'rgba(255,255,255,0.72)', fontSize: 12 },

  rangeRow: {
    flexDirection: 'row', gap: SPACING.xs,
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.full,
    padding: 4, borderWidth: 1, borderColor: colors.border,
  },
  rangeBtn: { flex: 1, paddingVertical: SPACING.sm, alignItems: 'center', borderRadius: RADIUS.full },
  rangeBtnActive: { backgroundColor: colors.primary },
  rangeText: { color: colors.textSecondary, fontSize: 13, fontWeight: '700' },
  rangeTextActive: { color: colors.text },

  section: { gap: SPACING.xs },
  sectionTitle: { color: colors.text, fontSize: 16, fontWeight: '800', paddingHorizontal: SPACING.xs },
  sectionSubtitle: { color: colors.textSecondary, fontSize: 12, paddingHorizontal: SPACING.xs, lineHeight: 17 },
  card: {
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: colors.border, padding: SPACING.md, marginTop: 2,
  },
  chartHint: { color: colors.textTertiary, fontSize: 11, fontWeight: '600', marginBottom: SPACING.sm, textTransform: 'uppercase', letterSpacing: 0.5 },
  innerDivider: { height: 0.5, backgroundColor: colors.border, marginVertical: SPACING.md },

  topRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  topRank: { width: 16, color: colors.primaryLight, fontSize: 14, fontWeight: '800', textAlign: 'center' },
  topThumb: { width: 44, height: 44, borderRadius: RADIUS.sm, backgroundColor: colors.surfaceElevated, alignItems: 'center', justifyContent: 'center' },
  topCaption: { color: colors.text, fontSize: 14, fontWeight: '600' },
  topStats: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
  topStat: { color: colors.textSecondary, fontSize: 12, marginRight: SPACING.xs },

  footnote: { color: colors.textTertiary, fontSize: 11, lineHeight: 16, paddingHorizontal: SPACING.xs, marginTop: SPACING.sm },
});
