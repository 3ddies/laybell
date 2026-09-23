import { View, Text, StyleSheet, TouchableOpacity, ScrollView, RefreshControl } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState, useCallback } from 'react';
import SwipeBackPager from '../../components/SwipeBackPager';
import { fetchPostAnalytics, type PostAnalytics } from '../../lib/analytics';
import { BarChart, HBars } from '../../components/AnalyticsCharts';
import { formatCount } from '../../lib/format';
import { isAudioPost } from '../../lib/genres';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { AnalyticsSkeleton } from '../../components/Skeleton';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function postedOn(iso: string): string {
  const d = new Date(iso);
  let h = d.getHours();
  const ampm = h < 12 ? 'AM' : 'PM';
  h = h % 12 === 0 ? 12 : h % 12;
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${MO[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} · ${h}:${m} ${ampm}`;
}
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
function unitWord(t: Translate, unit: string): string {
  return unit === 'hour' ? t('postAnalytics.perHour') : unit === 'week' ? t('postAnalytics.perWeek') : t('postAnalytics.perDay');
}

// A metric tile: quiet grey label, number-forward — no icon, no border. `big`
// gives the two headline metrics more presence, the way TikTok leads with views.
function Metric({ value, label, big }: { value: string; label: string; big?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.metric, big && styles.metricBig]}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, big && styles.metricValueBig]}>{value}</Text>
    </View>
  );
}
function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {!!subtitle && <Text style={styles.sectionSubtitle}>{subtitle}</Text>}
      <View style={styles.card}>{children}</View>
    </View>
  );
}

export default function PostAnalyticsScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [data, setData] = useState<PostAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!id) { setLoading(false); setRefreshing(false); return; }
    try {
      setData(await fetchPostAnalytics(id));
    } catch {
      setData(null);
    }
    setLoading(false);
    setRefreshing(false);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  return (
    <SwipeBackPager>
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.backBtn} onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('postAnalytics.title')}</Text>
          <View style={{ width: 40 }} />
        </View>

        {loading ? (
          <View style={{ flex: 1 }}><AnalyticsSkeleton /></View>
        ) : !data ? (
          <View style={styles.center}>
            <Ionicons name="bar-chart-outline" size={44} color={colors.textTertiary} />
            <Text style={styles.emptyTitle}>{t('postAnalytics.unavailableTitle')}</Text>
            <Text style={styles.emptySub}>{t('postAnalytics.unavailableSub')}</Text>
          </View>
        ) : (
          <Body data={data} refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />
        )}
      </View>
    </SwipeBackPager>
  );
}

function Body({ data, refreshing, onRefresh }: { data: PostAnalytics; refreshing: boolean; onRefresh: () => void }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();

  const audio = isAudioPost(data.type);
  const primaryValue = audio ? data.plays : data.views;
  const primaryLabel = audio ? t('postAnalytics.plays') : t('postAnalytics.views');
  const rate = data.reach > 0 ? `${data.engagementRate.toFixed(data.engagementRate < 10 ? 1 : 0)}%` : '—';

  const secondary = [
    { label: t('postAnalytics.likes'), value: data.likes },
    { label: t('postAnalytics.comments'), value: data.comments },
    { label: t('postAnalytics.shares'), value: data.shares },
    { label: t('postAnalytics.saves'), value: data.saves },
  ];
  if (audio && data.views > 0) secondary.push({ label: t('postAnalytics.views'), value: data.views });
  if (!audio && data.plays > 0) secondary.push({ label: t('postAnalytics.plays'), value: data.plays });

  const breakdown = [
    { label: t('postAnalytics.likes'), value: data.likes },
    { label: t('postAnalytics.comments'), value: data.comments },
    { label: t('postAnalytics.saves'), value: data.saves },
    { label: t('postAnalytics.shares'), value: data.shares },
  ].sort((a, b) => b.value - a.value);

  const topPct = data.rank && data.totalPosts ? Math.max(1, Math.round((data.rank / data.totalPosts) * 100)) : null;

  return (
    <ScrollView
      contentContainerStyle={styles.scroll}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      {/* Post header */}
      <View style={styles.postHead}>
        {data.thumb ? (
          <ExpoImage source={{ uri: data.thumb }} style={styles.postThumb} contentFit="cover" cachePolicy="memory-disk" />
        ) : (
          <LinearGradient colors={GRADIENTS.primarySoft} style={styles.postThumb}>
            <Ionicons name={data.type === 'video' ? 'videocam' : audio ? 'musical-notes' : 'image'} size={22} color={colors.primary} />
          </LinearGradient>
        )}
        <View style={{ flex: 1 }}>
          <Text style={styles.postCaption} numberOfLines={2}>{data.caption || typeLabel(t, data.type)}</Text>
          <Text style={styles.postDate}>{t('postAnalytics.postedOn', { date: postedOn(data.createdAt) })}</Text>
        </View>
      </View>

      {/* Headline metrics */}
      <View style={styles.metricRow}>
        <Metric value={formatCount(primaryValue)} label={primaryLabel} big />
        <Metric value={rate} label={t('postAnalytics.engagementRate')} big />
      </View>

      {/* Secondary metrics */}
      <View style={styles.metricGrid}>
        {secondary.map((m) => <Metric key={m.label} value={formatCount(m.value)} label={m.label} />)}
      </View>

      {/* Views over time (owner-only real series) */}
      {data.isOwner && data.seriesTotal > 0 && (
        <Section
          title={t('postAnalytics.reachOverTime')}
          subtitle={t('postAnalytics.reachOverTimeSub', { count: formatCount(data.seriesTotal), unit: unitWord(t, data.seriesUnit) })}
        >
          <BarChart data={data.series} />
        </Section>
      )}

      {/* Engagement over time (public: likes + comments) */}
      {data.engagements > 0 && data.engagementSeries.some((d) => d.value > 0) && (
        <Section
          title={t('postAnalytics.engagementOverTime')}
          subtitle={t('postAnalytics.engagementOverTimeSub', { unit: unitWord(t, data.seriesUnit) })}
        >
          <BarChart data={data.engagementSeries} />
        </Section>
      )}

      {/* Engagement breakdown */}
      {data.engagements > 0 && (
        <Section title={t('postAnalytics.breakdown')} subtitle={t('postAnalytics.breakdownSub')}>
          <HBars data={breakdown} accentTop />
        </Section>
      )}

      {/* How it compares — a quiet card, not a heavy gradient */}
      {data.vsAverage != null && topPct != null && (
        <View style={styles.compareCard}>
          <View style={{ flex: 1 }}>
            <Text style={styles.compareValue}>{data.vsAverage >= 10 ? Math.round(data.vsAverage) : data.vsAverage.toFixed(1)}×</Text>
            <Text style={styles.compareLabel}>{t('postAnalytics.vsAverage')}</Text>
          </View>
          <View style={styles.compareRight}>
            <Text style={styles.compareRank}>
              {data.rank === 1 ? t('postAnalytics.topPost') : t('postAnalytics.topPercent', { pct: topPct })}
            </Text>
            <Text style={styles.compareSmall}>{t('postAnalytics.ofYourPosts', { count: data.totalPosts })}</Text>
          </View>
        </View>
      )}

      <Text style={styles.footnote}>{t('postAnalytics.footnote')}</Text>
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
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },

  scroll: { padding: SPACING.md, paddingBottom: SPACING.xxl + SPACING.lg, gap: SPACING.lg },

  postHead: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, paddingHorizontal: SPACING.xs },
  postThumb: { width: 52, height: 52, borderRadius: RADIUS.md, backgroundColor: colors.surfaceElevated, alignItems: 'center', justifyContent: 'center' },
  postCaption: { color: colors.text, fontSize: 15, fontWeight: '700', lineHeight: 20 },
  postDate: { color: colors.textTertiary, fontSize: 12, marginTop: 3 },

  // Soft, borderless surfaces — the "floating card" look, one shared shadow.
  metricRow: { flexDirection: 'row', gap: SPACING.sm },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  metric: {
    width: '48%', flexGrow: 1,
    backgroundColor: colors.surfaceElevated, borderRadius: RADIUS.lg,
    paddingVertical: SPACING.md, paddingHorizontal: SPACING.md, gap: 6,
    shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 1,
  },
  metricBig: { paddingVertical: SPACING.md + SPACING.xs },
  metricLabel: { color: colors.textSecondary, fontSize: 13, fontWeight: '500' },
  metricValue: { color: colors.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.3 },
  metricValueBig: { fontSize: 30 },

  section: { gap: SPACING.sm },
  sectionTitle: { color: colors.text, fontSize: 16, fontWeight: '800', paddingHorizontal: SPACING.xs },
  sectionSubtitle: { color: colors.textSecondary, fontSize: 12.5, paddingHorizontal: SPACING.xs, lineHeight: 17, marginTop: -4 },
  card: {
    backgroundColor: colors.surfaceElevated, borderRadius: RADIUS.lg, padding: SPACING.md, marginTop: 2,
    shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 1,
  },

  compareCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surfaceElevated, borderRadius: RADIUS.lg, padding: SPACING.md + SPACING.xs,
    shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 1,
  },
  compareValue: { color: colors.primary, fontSize: 30, fontWeight: '800', letterSpacing: -0.5 },
  compareLabel: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  compareRight: { alignItems: 'flex-end', gap: 3 },
  compareRank: { color: colors.text, fontSize: 15, fontWeight: '800' },
  compareSmall: { color: colors.textTertiary, fontSize: 12 },

  footnote: { color: colors.textTertiary, fontSize: 11, lineHeight: 16, paddingHorizontal: SPACING.xs },
});
