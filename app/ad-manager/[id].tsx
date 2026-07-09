import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert, RefreshControl,
} from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useState } from 'react';
import {
  fetchAdCampaign, fetchAdAnalytics, effectiveAdStatus, fmtPrice,
  pauseAdCampaign, resumeAdCampaign, endAdCampaign,
  type AdCampaign, type AdAnalytics, type AdStatus,
} from '../../lib/ads';
import { BarChart, HBars } from '../../components/AnalyticsCharts';
import { Skeleton, SkeletonLine } from '../../components/Skeleton';
import SwipeBackPager from '../../components/SwipeBackPager';
import { SPACING, RADIUS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';

// Campaign detail + analytics. Reuses the Creator Analytics chart components
// (BarChart / HBars) and reads ad_events (owner-readable) via fetchAdAnalytics.

type TFn = (key: string, vars?: Record<string, string | number>) => string;

const statusLabel = (t: TFn): Record<AdStatus, string> => ({
  pending: t('adDetail.statusDraft'),
  active: t('adDetail.statusLive'),
  paused: t('adDetail.statusPaused'),
  ended: t('adDetail.statusEnded'),
  canceled: t('adDetail.statusCanceled'),
});

export default function AdDetailScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const STATUS_LABEL = statusLabel(t);

  const [campaign, setCampaign] = useState<AdCampaign | null>(null);
  const [analytics, setAnalytics] = useState<AdAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const [c, a] = await Promise.all([fetchAdCampaign(id), fetchAdAnalytics(id)]);
    setCampaign(c);
    setAnalytics(a);
    setLoading(false);
    setRefreshing(false);
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function doAction(fn: (id: string) => Promise<boolean>, failMsg: string) {
    if (!id) return;
    setBusy(true);
    const ok = await fn(id);
    setBusy(false);
    if (ok) load();
    else Alert.alert(t('adDetail.errorTitle'), failMsg);
  }

  function confirmEnd() {
    Alert.alert(t('adDetail.endConfirmTitle'), t('adDetail.endConfirmBody'), [
      { text: t('adDetail.keepRunning'), style: 'cancel' },
      { text: t('adDetail.endCampaign'), style: 'destructive', onPress: () => doAction(endAdCampaign, t('adDetail.endFailed')) },
    ]);
  }

  const status = campaign ? effectiveAdStatus(campaign) : 'ended';
  const spent = campaign?.spent_cents ?? 0;
  const budget = campaign?.budget_cents_total ?? 0;
  const pct = budget > 0 ? Math.min(1, spent / budget) : 0;

  return (
    <SwipeBackPager>
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle} numberOfLines={1}>{campaign?.advertiser_name || t('adDetail.headerFallback')}</Text>
          <View style={{ width: 40 }} />
        </View>

        {loading ? (
          <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
            {/* Status + spend card */}
            <View style={styles.card}>
              <View style={styles.titleRow}>
                <SkeletonLine w="55%" h={16} />
                <Skeleton width={64} height={20} radius={RADIUS.full} />
              </View>
              <SkeletonLine w="70%" h={12} />
              <View style={styles.budgetRow}>
                <SkeletonLine w={120} h={12} />
                <SkeletonLine w={32} h={12} />
              </View>
              <Skeleton width="100%" height={6} radius={RADIUS.full} />
            </View>

            {/* Stats grid (3x2) */}
            <View style={styles.statsGrid}>
              {Array.from({ length: 6 }).map((_, i) => (
                <View key={i} style={styles.statCard}>
                  <SkeletonLine w={44} h={18} />
                  <SkeletonLine w={56} h={11} style={{ marginTop: 4 }} />
                </View>
              ))}
            </View>

            {/* Chart / card blocks with section-title bars */}
            {Array.from({ length: 3 }).map((_, i) => (
              <View key={i}>
                <SkeletonLine w={120} h={11} style={{ marginHorizontal: SPACING.xs, marginBottom: SPACING.sm }} />
                <View style={styles.card}>
                  <Skeleton width="100%" height={i === 2 ? 18 : 120} radius={RADIUS.md} />
                </View>
              </View>
            ))}
          </ScrollView>
        ) : !campaign ? (
          <View style={styles.center}><Text style={styles.empty}>{t('adDetail.notFound')}</Text></View>
        ) : (
          <ScrollView
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
          >
            {/* Status + spend */}
            <View style={styles.card}>
              <View style={styles.titleRow}>
                <Text style={styles.cardTitle} numberOfLines={1}>{campaign.advertiser_name || t('adDetail.untitled')}</Text>
                <View style={[styles.statusChip, { borderColor: statusColor(status, colors) }]}>
                  <Text style={[styles.statusChipText, { color: statusColor(status, colors) }]}>{STATUS_LABEL[status]}</Text>
                </View>
              </View>
              <Text style={styles.sub}>{(campaign.placements ?? []).join(' · ') || t('adDetail.noPlacements')} · {campaign.objective ?? 'awareness'}</Text>
              <View style={styles.budgetRow}>
                <Text style={styles.budgetText}>{t('adDetail.spentOf', { spent: fmtPrice(spent), total: fmtPrice(budget) })}</Text>
                <Text style={styles.budgetPct}>{Math.round(pct * 100)}%</Text>
              </View>
              <View style={styles.budgetTrack}><View style={[styles.budgetFill, { width: `${pct * 100}%` }]} /></View>
            </View>

            {/* Headline stats */}
            <View style={styles.statsGrid}>
              <Stat label={t('adDetail.statViews')} value={fmt(analytics?.impressions ?? 0)} styles={styles} />
              <Stat label={t('adDetail.statReach')} value={fmt(analytics?.reach ?? 0)} styles={styles} />
              <Stat label={t('adDetail.statClicks')} value={fmt(analytics?.clicks ?? 0)} styles={styles} />
              <Stat label={t('adDetail.statCtr')} value={`${((analytics?.ctr ?? 0) * 100).toFixed(1)}%`} styles={styles} />
              <Stat label={t('adDetail.statSpent')} value={fmtPrice(spent)} styles={styles} />
              <Stat label={t('adDetail.statSkips')} value={fmt(analytics?.skips ?? 0)} styles={styles} />
            </View>

            {/* Views per day */}
            <Text style={styles.sectionTitle}>{t('adDetail.viewsOverTime')}</Text>
            <View style={styles.card}>
              <BarChart data={(analytics?.series ?? []).map((s) => ({ label: s.label.slice(5), value: s.impressions }))} />
            </View>

            {/* By placement */}
            {analytics && analytics.byPlacement.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>{t('adDetail.byPlacement')}</Text>
                <View style={styles.card}>
                  <HBars
                    accentTop
                    data={analytics.byPlacement.map((p) => ({
                      label: p.placement,
                      value: p.impressions,
                      caption: t('adDetail.placementCaption', { views: p.impressions, clicks: p.clicks }),
                    }))}
                  />
                </View>
              </>
            )}

            {/* Targeting summary */}
            <Text style={styles.sectionTitle}>{t('adDetail.audience')}</Text>
            <View style={styles.card}>
              <Text style={styles.targetText}>{targetingSummary(campaign, t)}</Text>
            </View>

            {/* Controls */}
            {(status === 'active' || status === 'paused') && (
              <View style={styles.actions}>
                {status === 'active' ? (
                  <TouchableOpacity style={styles.ghostBtn} disabled={busy} onPress={() => doAction(pauseAdCampaign, t('adDetail.pauseFailed'))}>
                    <Ionicons name="pause" size={16} color={colors.text} />
                    <Text style={styles.ghostBtnText}>{t('adDetail.pause')}</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity style={styles.primaryBtn} disabled={busy} onPress={() => doAction(resumeAdCampaign, t('adDetail.resumeFailed'))}>
                    <Ionicons name="play" size={16} color={colors.text} />
                    <Text style={styles.primaryBtnText}>{t('adDetail.resume')}</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity style={[styles.ghostBtn, { borderColor: colors.error }]} disabled={busy} onPress={confirmEnd}>
                  <Text style={[styles.ghostBtnText, { color: colors.error }]}>{t('adDetail.end')}</Text>
                </TouchableOpacity>
              </View>
            )}
          </ScrollView>
        )}
      </View>
    </SwipeBackPager>
  );
}

function statusColor(s: AdStatus, colors: ThemePalette): string {
  if (s === 'active') return colors.primary;
  if (s === 'paused') return '#F59E0B';
  return colors.textTertiary;
}

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function targetingSummary(c: AdCampaign, t: TFn): string {
  const parts: string[] = [];
  if (c.target_age_min != null || c.target_age_max != null) parts.push(t('adDetail.ageRange', { min: c.target_age_min ?? 0, max: c.target_age_max ?? '∞' }));
  if (c.target_gender) parts.push(c.target_gender);
  if (c.target_genres?.length) parts.push(c.target_genres.join(', '));
  if (c.target_radius_km != null) parts.push(t('adDetail.withinRadius', { km: c.target_radius_km }));
  return parts.length ? parts.join(' · ') : t('adDetail.reachingEveryone');
}

function Stat({ label, value, styles }: { label: string; value: string; styles: any }) {
  return (
    <View style={styles.statCard}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { color: colors.textSecondary, fontSize: 15 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm,
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.borderSubtle,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '800', flex: 1, textAlign: 'center' },

  scroll: { padding: SPACING.md, gap: SPACING.md, paddingBottom: SPACING.xxl },

  card: {
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: colors.border, padding: SPACING.md, gap: SPACING.sm,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.sm },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: '800', flexShrink: 1 },
  sub: { color: colors.textSecondary, fontSize: 12, textTransform: 'capitalize' },
  statusChip: { borderWidth: 1, borderRadius: RADIUS.full, paddingHorizontal: SPACING.sm, paddingVertical: 2 },
  statusChipText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.3 },

  budgetRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: SPACING.xs },
  budgetText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  budgetPct: { color: colors.textTertiary, fontSize: 12, fontWeight: '700' },
  budgetTrack: { height: 6, borderRadius: RADIUS.full, backgroundColor: colors.surfaceElevated, overflow: 'hidden' },
  budgetFill: { height: '100%', borderRadius: RADIUS.full, backgroundColor: colors.primary },

  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  statCard: {
    width: '31.5%', backgroundColor: colors.surfaceLight, borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: colors.border, padding: SPACING.md, alignItems: 'center', gap: 2,
  },
  statValue: { color: colors.text, fontSize: 18, fontWeight: '800' },
  statLabel: { color: colors.textSecondary, fontSize: 11 },

  sectionTitle: {
    color: colors.textTertiary, fontSize: 11, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.8, paddingHorizontal: SPACING.xs,
  },
  targetText: { color: colors.text, fontSize: 13, textTransform: 'capitalize' },

  actions: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.sm },
  primaryBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: colors.primary, borderRadius: RADIUS.full, paddingVertical: SPACING.md,
  },
  primaryBtnText: { color: colors.text, fontSize: 14, fontWeight: '800' },
  ghostBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS.full, paddingVertical: SPACING.md,
  },
  ghostBtnText: { color: colors.text, fontSize: 14, fontWeight: '800' },
});
