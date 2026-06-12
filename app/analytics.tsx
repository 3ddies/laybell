import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, ActivityIndicator, Image, RefreshControl,
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
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';

const RANGES: { key: RangeMode; label: string }[] = [
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
  { key: '90d', label: '90D' },
  { key: 'all', label: 'All' },
];

const WD_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function typeLabel(t: string): string {
  switch (t) {
    case 'image': return 'Photos';
    case 'video': return 'Videos';
    case 'audio': return 'Music';
    case 'podcast': return 'Podcasts';
    case 'audiobook': return 'Audiobooks';
    default: return t.charAt(0).toUpperCase() + t.slice(1);
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
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Creator Analytics</Text>
        <View style={{ width: 40 }} />
      </View>

          {loading ? (
            <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
          ) : !data || data.totals.posts === 0 ? (
            <View style={styles.center}>
              <Ionicons name="bar-chart-outline" size={44} color={colors.textTertiary} />
              <Text style={styles.emptyTitle}>No analytics yet</Text>
              <Text style={styles.emptySub}>Post some content and grow your audience — your stats and charts will show up here.</Text>
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
  const { totals } = data;
  const followerSeries = buildSeries(data.followerTs, range);
  const engagementSeries = buildSeries(data.engagementTs, range);
  const newFollowers = countInRange(data.followerTs, range);
  const engagementInRange = countInRange(data.engagementTs, range);

  const dayData = data.byDay.map((v, i) => ({ label: WD_SHORT[i], value: v }));
  const hourData = data.byHour.map((v, i) => ({ label: shortHour(i), value: v }));

  const mixData = data.contentMix.map((m) => ({
    label: typeLabel(m.type), value: m.count, caption: `${m.count} ${m.count === 1 ? 'post' : 'posts'}`,
  }));
  const bestType = [...data.contentMix].filter((m) => m.count > 0).sort((a, b) => b.avgEngagement - a.avgEngagement)[0];

  const rangeWord = range === 'all' ? 'this year' : range === '7d' ? 'this week' : range === '30d' ? 'this month' : 'in 90 days';

  return (
    <ScrollView
      contentContainerStyle={styles.scroll}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      {/* Lifetime overview */}
      <Text style={styles.overviewLabel}>Lifetime</Text>
      <View style={styles.statGrid}>
        <StatCard icon="people" value={formatCount(totals.followers)} label="Followers" />
        <StatCard icon="grid" value={formatCount(totals.posts)} label="Posts" />
        <StatCard icon="heart" value={formatCount(totals.likes)} label="Likes" tint={colors.like} />
        <StatCard icon="chatbubble" value={formatCount(totals.comments)} label="Comments" />
        <StatCard icon="bookmark" value={formatCount(totals.saves)} label="Saves" />
        <StatCard icon="play" value={formatCount(totals.views)} label="Views & plays" />
      </View>

      {/* Engagement rate highlight */}
      <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.rateCard}>
        <View style={{ flex: 1 }}>
          <Text style={styles.rateValue}>{data.engagementRate.toFixed(1)}</Text>
          <Text style={styles.rateLabel}>Avg engagement per post</Text>
        </View>
        <View style={styles.rateRight}>
          <Text style={styles.rateSmall}>{formatCount(totals.shares)} shares</Text>
          <Text style={styles.rateSmall}>{formatCount(totals.following)} following</Text>
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
            <Text style={[styles.rangeText, range === r.key && styles.rangeTextActive]}>{r.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Follower growth */}
      <Section title="New followers" subtitle={`${newFollowers >= 0 ? '+' : ''}${formatCount(newFollowers)} ${rangeWord}`}>
        <BarChart data={followerSeries} />
      </Section>

      {/* Engagement over time */}
      <Section title="Engagement received" subtitle={`${formatCount(engagementInRange)} likes & comments ${rangeWord}`}>
        <BarChart data={engagementSeries} />
      </Section>

      {/* Best times */}
      <Section
        title="When your audience is active"
        subtitle={
          data.peakDay != null && data.peakHour != null
            ? `Most active on ${dayLabel(data.peakDay)}s around ${hourLabel(data.peakHour)} — a good time to post.`
            : 'Engagement timing will appear as people interact with your posts.'
        }
      >
        <Text style={styles.chartHint}>By day of week</Text>
        <BarChart data={dayData} height={110} />
        <View style={styles.innerDivider} />
        <Text style={styles.chartHint}>By hour of day</Text>
        <BarChart data={hourData} height={110} />
      </Section>

      {/* Content performance */}
      {mixData.length > 0 && (
        <Section
          title="Content mix"
          subtitle={bestType ? `Your ${typeLabel(bestType.type).toLowerCase()} get the most engagement (avg ${bestType.avgEngagement.toFixed(1)}/post).` : undefined}
        >
          <HBars data={mixData} accentTop />
        </Section>
      )}

      {/* Top posts */}
      {data.topPosts.length > 0 && (
        <Section title="Top posts" subtitle="Your best-performing content by engagement.">
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
                  <Text style={styles.topCaption} numberOfLines={1}>{p.caption || typeLabel(p.type)}</Text>
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

      <Text style={styles.footnote}>
        Stats are aggregated from your posts, followers and the engagement they receive. Demographic data (age, location) isn't collected, so it isn't shown.
      </Text>
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
  rateLabel: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  rateRight: { alignItems: 'flex-end', gap: 4 },
  rateSmall: { color: colors.textSecondary, fontSize: 12 },

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
