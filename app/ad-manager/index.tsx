import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  ActivityIndicator, Alert, RefreshControl,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useState } from 'react';
import {
  fetchMyAdCampaigns, effectiveAdStatus, fmtPrice,
  pauseAdCampaign, resumeAdCampaign, endAdCampaign,
  type AdCampaign, type AdStatus, type AdPlacement,
} from '../../lib/ads';
import SwipeBackPager from '../../components/SwipeBackPager';
import { SPACING, RADIUS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';

// Ad Manager — create and manage dedicated-creative ad campaigns across the
// feed, reels and audio. Separate from Spotlight (which promotes an existing
// post). Reached from Settings → Ad Manager. Each card doubles as a quick
// performance read; tapping opens the full analytics detail.

const STATUS_LABEL: Record<AdStatus, string> = {
  pending: 'Draft',
  active: 'Live',
  paused: 'Paused',
  ended: 'Ended',
  canceled: 'Canceled',
};

const PLACEMENT_ICON: Record<AdPlacement, any> = {
  feed: 'home-outline',
  reels: 'film-outline',
  audio: 'musical-notes-outline',
};

export default function AdManagerScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();

  const [campaigns, setCampaigns] = useState<AdCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setCampaigns(await fetchMyAdCampaigns());
    setLoading(false);
    setRefreshing(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  function statusColor(s: AdStatus): string {
    switch (s) {
      case 'active': return colors.primary;
      case 'paused': return '#F59E0B';
      default: return colors.textTertiary;
    }
  }

  async function doAction(id: string, fn: (id: string) => Promise<boolean>, failMsg: string) {
    setBusyId(id);
    const ok = await fn(id);
    setBusyId(null);
    if (ok) load();
    else Alert.alert('Error', failMsg);
  }

  function confirmEnd(c: AdCampaign) {
    Alert.alert(
      'End this campaign?',
      'It stops serving right away. Spent budget is not refunded.',
      [
        { text: 'Keep running', style: 'cancel' },
        { text: 'End campaign', style: 'destructive', onPress: () => doAction(c.id, endAdCampaign, 'Could not end the campaign.') },
      ],
    );
  }

  function renderCampaign(c: AdCampaign) {
    const status = effectiveAdStatus(c);
    const spent = c.spent_cents ?? 0;
    const budget = c.budget_cents_total ?? 0;
    const pct = budget > 0 ? Math.min(1, spent / budget) : 0;
    const impressions = c.impression_count ?? 0;
    const clicks = c.click_count ?? 0;
    const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
    const placements = c.placements ?? [];

    return (
      <TouchableOpacity
        key={c.id}
        style={styles.card}
        activeOpacity={0.85}
        onPress={() => router.push(`/ad-manager/${c.id}`)}
      >
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle} numberOfLines={1}>{c.advertiser_name || 'Untitled campaign'}</Text>
          <View style={[styles.statusChip, { borderColor: statusColor(status) }]}>
            <Text style={[styles.statusChipText, { color: statusColor(status) }]}>{STATUS_LABEL[status]}</Text>
          </View>
        </View>

        <View style={styles.placeRow}>
          {placements.map((p) => (
            <View key={p} style={styles.placeChip}>
              <Ionicons name={PLACEMENT_ICON[p]} size={12} color={colors.textSecondary} />
              <Text style={styles.placeChipText}>{p}</Text>
            </View>
          ))}
        </View>

        {/* Spend / budget */}
        <View style={styles.budgetRow}>
          <Text style={styles.budgetText}>{fmtPrice(spent)} of {fmtPrice(budget)}</Text>
          <Text style={styles.budgetPct}>{Math.round(pct * 100)}%</Text>
        </View>
        <View style={styles.budgetTrack}>
          <View style={[styles.budgetFill, { width: `${pct * 100}%` }]} />
        </View>

        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Ionicons name="eye-outline" size={15} color={colors.textSecondary} />
            <Text style={styles.statText}>{impressions} views</Text>
          </View>
          <View style={styles.stat}>
            <Ionicons name="open-outline" size={15} color={colors.textSecondary} />
            <Text style={styles.statText}>{clicks} clicks</Text>
          </View>
          <View style={styles.stat}>
            <Ionicons name="trending-up-outline" size={15} color={colors.textSecondary} />
            <Text style={styles.statText}>{ctr.toFixed(1)}% CTR</Text>
          </View>
        </View>

        {(status === 'active' || status === 'paused') && (
          <View style={styles.cardActions}>
            {status === 'active' ? (
              <TouchableOpacity style={styles.cardActionGhost} disabled={busyId === c.id} onPress={() => doAction(c.id, pauseAdCampaign, 'Could not pause.')}>
                <Text style={styles.cardActionGhostText}>Pause</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.cardActionPrimary} disabled={busyId === c.id} onPress={() => doAction(c.id, resumeAdCampaign, 'Could not resume.')}>
                <Ionicons name="play" size={14} color={colors.text} />
                <Text style={styles.cardActionPrimaryText}>Resume</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.cardActionGhost} disabled={busyId === c.id} onPress={() => confirmEnd(c)}>
              <Text style={styles.cardActionGhostText}>End</Text>
            </TouchableOpacity>
          </View>
        )}
      </TouchableOpacity>
    );
  }

  return (
    <SwipeBackPager>
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={24} color={colors.primary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Ad Manager</Text>
          <View style={{ width: 40 }} />
        </View>

        {loading ? (
          <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
        ) : (
          <ScrollView
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />
            }
          >
            <Text style={styles.hint}>
              Run ads across the Home feed, Reels and music breaks. Upload a creative, set a budget,
              optionally target an audience, and track performance — all here.
            </Text>

            <TouchableOpacity style={styles.createBtn} onPress={() => router.push('/ad-manager/create')} activeOpacity={0.85}>
              <LinearGradient colors={[colors.primary, colors.primaryDark ?? colors.primary]} style={styles.createBtnInner}>
                <Ionicons name="megaphone" size={18} color={colors.text} />
                <Text style={styles.createBtnText}>Create an Ad</Text>
              </LinearGradient>
            </TouchableOpacity>

            {campaigns.length === 0 ? (
              <View style={styles.empty}>
                <Ionicons name="megaphone-outline" size={44} color={colors.textTertiary} />
                <Text style={styles.emptyTitle}>No campaigns yet</Text>
                <Text style={styles.emptySub}>Your ad campaigns and their performance will show up here.</Text>
              </View>
            ) : (
              <View style={styles.cards}>
                <Text style={styles.sectionTitle}>Your campaigns</Text>
                {campaigns.map(renderCampaign)}
              </View>
            )}
          </ScrollView>
        )}
      </View>
    </SwipeBackPager>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm,
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.borderSubtle,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },

  scroll: { padding: SPACING.md, paddingBottom: SPACING.xxl, gap: SPACING.md },
  hint: { color: colors.textSecondary, fontSize: 12, lineHeight: 18 },

  createBtn: { borderRadius: RADIUS.lg, overflow: 'hidden' },
  createBtnInner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm,
    paddingVertical: SPACING.md,
  },
  createBtnText: { color: colors.text, fontSize: 15, fontWeight: '800' },

  sectionTitle: {
    color: colors.textTertiary, fontSize: 11, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.8, paddingHorizontal: SPACING.xs,
  },
  cards: { gap: SPACING.sm },
  card: {
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: SPACING.md, gap: SPACING.sm,
  },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.sm },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: '800', flexShrink: 1 },
  statusChip: { borderWidth: 1, borderRadius: RADIUS.full, paddingHorizontal: SPACING.sm, paddingVertical: 2 },
  statusChipText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.3 },

  placeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  placeChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: colors.surfaceElevated, borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.sm, paddingVertical: 3,
  },
  placeChipText: { color: colors.textSecondary, fontSize: 11, fontWeight: '600', textTransform: 'capitalize' },

  budgetRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  budgetText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  budgetPct: { color: colors.textTertiary, fontSize: 12, fontWeight: '700' },
  budgetTrack: { height: 6, borderRadius: RADIUS.full, backgroundColor: colors.surfaceElevated, overflow: 'hidden' },
  budgetFill: { height: '100%', borderRadius: RADIUS.full, backgroundColor: colors.primary },

  statsRow: {
    flexDirection: 'row', gap: SPACING.lg,
    borderTopWidth: 0.5, borderTopColor: colors.border, paddingTop: SPACING.sm,
  },
  stat: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  statText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },

  cardActions: { flexDirection: 'row', gap: SPACING.sm },
  cardActionPrimary: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: colors.primary, borderRadius: RADIUS.full,
    paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md, flex: 1,
  },
  cardActionPrimaryText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  cardActionGhost: {
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS.full,
    paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md, flex: 1,
  },
  cardActionGhostText: { color: colors.textSecondary, fontSize: 13, fontWeight: '700' },

  empty: { alignItems: 'center', paddingTop: SPACING.xxl, gap: SPACING.sm, paddingHorizontal: SPACING.lg },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  emptySub: { color: colors.textSecondary, fontSize: 13, textAlign: 'center' },
});
