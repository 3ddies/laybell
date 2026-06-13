import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, Alert, RefreshControl,
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
import SwipeBackPager from '../../components/SwipeBackPager';
import { SPACING, RADIUS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';

// Campaign detail + analytics. Reuses the Creator Analytics chart components
// (BarChart / HBars) and reads ad_events (owner-readable) via fetchAdAnalytics.

const STATUS_LABEL: Record<AdStatus, string> = {
  pending: 'Draft', active: 'Live', paused: 'Paused', ended: 'Ended', canceled: 'Canceled',
};

export default function AdDetailScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

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
    else Alert.alert('Error', failMsg);
  }

  function confirmEnd() {
    Alert.alert('End this campaign?', 'It stops serving right away. Spent budget is not refunded.', [
      { text: 'Keep running', style: 'cancel' },
      { text: 'End campaign', style: 'destructive', onPress: () => doAction(endAdCampaign, 'Could not end the campaign.') },
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
            <Ionicons name="chevron-back" size={24} color={colors.primary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle} numberOfLines={1}>{campaign?.advertiser_name || 'Campaign'}</Text>
          <View style={{ width: 40 }} />
        </View>

        {loading ? (
          <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
        ) : !campaign ? (
          <View style={styles.center}><Text style={styles.empty}>Campaign not found</Text></View>
        ) : (
          <ScrollView
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
          >
            {/* Status + spend */}
            <View style={styles.card}>
              <View style={styles.titleRow}>
                <Text style={styles.cardTitle} numberOfLines={1}>{campaign.advertiser_name || 'Untitled'}</Text>
                <View style={[styles.statusChip, { borderColor: statusColor(status, colors) }]}>
                  <Text style={[styles.statusChipText, { color: statusColor(status, colors) }]}>{STATUS_LABEL[status]}</Text>
                </View>
              </View>
              <Text style={styles.sub}>{(campaign.placements ?? []).join(' · ') || 'no placements'} · {campaign.objective ?? 'awareness'}</Text>
              <View style={styles.budgetRow}>
                <Text style={styles.budgetText}>{fmtPrice(spent)} spent of {fmtPrice(budget)}</Text>
                <Text style={styles.budgetPct}>{Math.round(pct * 100)}%</Text>
              </View>
              <View style={styles.budgetTrack}><View style={[styles.budgetFill, { width: `${pct * 100}%` }]} /></View>
            </View>

            {/* Headline stats */}
            <View style={styles.statsGrid}>
              <Stat label="Views" value={fmt(analytics?.impressions ?? 0)} styles={styles} />
              <Stat label="Reach" value={fmt(analytics?.reach ?? 0)} styles={styles} />
              <Stat label="Clicks" value={fmt(analytics?.clicks ?? 0)} styles={styles} />
              <Stat label="CTR" value={`${((analytics?.ctr ?? 0) * 100).toFixed(1)}%`} styles={styles} />
              <Stat label="Spent" value={fmtPrice(spent)} styles={styles} />
              <Stat label="Skips" value={fmt(analytics?.skips ?? 0)} styles={styles} />
            </View>

            {/* Views per day */}
            <Text style={styles.sectionTitle}>Views over time</Text>
            <View style={styles.card}>
              <BarChart data={(analytics?.series ?? []).map((s) => ({ label: s.label.slice(5), value: s.impressions }))} />
            </View>

            {/* By placement */}
            {analytics && analytics.byPlacement.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>By placement</Text>
                <View style={styles.card}>
                  <HBars
                    accentTop
                    data={analytics.byPlacement.map((p) => ({
                      label: p.placement,
                      value: p.impressions,
                      caption: `${p.impressions} views · ${p.clicks} clicks`,
                    }))}
                  />
                </View>
              </>
            )}

            {/* Targeting summary */}
            <Text style={styles.sectionTitle}>Audience</Text>
            <View style={styles.card}>
              <Text style={styles.targetText}>{targetingSummary(campaign)}</Text>
            </View>

            {/* Controls */}
            {(status === 'active' || status === 'paused') && (
              <View style={styles.actions}>
                {status === 'active' ? (
                  <TouchableOpacity style={styles.ghostBtn} disabled={busy} onPress={() => doAction(pauseAdCampaign, 'Could not pause.')}>
                    <Ionicons name="pause" size={16} color={colors.text} />
                    <Text style={styles.ghostBtnText}>Pause</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity style={styles.primaryBtn} disabled={busy} onPress={() => doAction(resumeAdCampaign, 'Could not resume.')}>
                    <Ionicons name="play" size={16} color={colors.text} />
                    <Text style={styles.primaryBtnText}>Resume</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity style={[styles.ghostBtn, { borderColor: colors.error }]} disabled={busy} onPress={confirmEnd}>
                  <Text style={[styles.ghostBtnText, { color: colors.error }]}>End</Text>
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

function targetingSummary(c: AdCampaign): string {
  const parts: string[] = [];
  if (c.target_age_min != null || c.target_age_max != null) parts.push(`Age ${c.target_age_min ?? 0}–${c.target_age_max ?? '∞'}`);
  if (c.target_gender) parts.push(c.target_gender);
  if (c.target_genres?.length) parts.push(c.target_genres.join(', '));
  if (c.target_radius_km != null) parts.push(`within ${c.target_radius_km}km`);
  return parts.length ? parts.join(' · ') : 'Reaching everyone (no targeting)';
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
