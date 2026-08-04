import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  Alert, RefreshControl,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useState } from 'react';
import {
  fetchMyAdCampaigns, effectiveAdStatus, fmtPrice,
  pauseAdCampaign, resumeAdCampaign, endAdCampaign,
  type AdCampaign, type AdStatus,
} from '../../lib/ads';
import { formatCount } from '../../lib/format';
import SwipeBackPager from '../../components/SwipeBackPager';
import { SPACING, RADIUS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { Skeleton, SkeletonLine } from '../../components/Skeleton';

type TFn = (key: string, vars?: Record<string, string | number>) => string;

// Ad Manager — create and manage dedicated-creative ad campaigns across the
// feed, reels and audio. Separate from Spotlight (which promotes an existing
// post). Reached from Settings → Ad Manager. Each card doubles as a quick
// performance read; tapping opens the full analytics detail.

const statusLabel = (t: TFn): Record<AdStatus, string> => ({
  pending: t('adManager.statusPending'),
  active: t('adManager.statusActive'),
  paused: t('adManager.statusPaused'),
  ended: t('adManager.statusEnded'),
  canceled: t('adManager.statusCanceled'),
});

export default function AdManagerScreen() {
  const { colors, mode } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { t } = useTranslation();
  const STATUS_LABEL = statusLabel(t);

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

  // Matches the Spotlight screen. Live is GREEN, not the brand orange: orange is
  // the app's action colour (it's on Create an Ad right above these cards), so an
  // orange badge read as something to tap rather than a state. The brand green is
  // tuned for dark surfaces and falls to ~2.3:1 on the light theme behind small
  // bold text, so light mode takes a deeper leaf green that reads as the same
  // colour but clears AA. Same for the amber paused badge.
  const successInk = mode === 'light' ? '#15803D' : colors.success;
  const warnInk = mode === 'light' ? '#B45309' : '#F59E0B';

  function statusColor(s: AdStatus): string {
    switch (s) {
      case 'active': return successInk;
      case 'paused': return warnInk;
      default: return colors.textSecondary;
    }
  }

  // Soft tinted capsule rather than a hairline outline — a 1px outline around
  // 10px text is a Material chip; a low-alpha fill of the same hue is the iOS
  // badge idiom and stays legible on every surface.
  function statusTint(s: AdStatus): string {
    switch (s) {
      case 'active': return successInk + '24';
      case 'paused': return warnInk + '24';
      default: return colors.surfaceElevated;
    }
  }

  async function doAction(id: string, fn: (id: string) => Promise<boolean>, failMsg: string) {
    setBusyId(id);
    const ok = await fn(id);
    setBusyId(null);
    if (ok) load();
    else Alert.alert(t('adManager.errorTitle'), failMsg);
  }

  // Separate from doAction because ending returns money — see the detail screen.
  async function doEnd(id: string) {
    setBusyId(id);
    const res = await endAdCampaign(id);
    setBusyId(null);
    if (!res.ok) { Alert.alert(t('adManager.errorTitle'), t('adManager.errEnd')); return; }
    load();
    if (res.refundedCents > 0) {
      Alert.alert(t('adDetail.endedTitle'), t('adDetail.endedRefunded', { amount: fmtPrice(res.refundedCents) }));
    }
  }

  function confirmEnd(c: AdCampaign) {
    Alert.alert(
      t('adManager.endTitle'),
      t('adManager.endBody'),
      [
        { text: t('adManager.keepRunning'), style: 'cancel' },
        { text: t('adManager.endConfirm'), style: 'destructive', onPress: () => doEnd(c.id) },
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
          <Text style={styles.cardTitle} numberOfLines={1}>{c.advertiser_name || t('adManager.untitled')}</Text>
          <View style={[styles.statusChip, { backgroundColor: statusTint(status) }]}>
            <Text style={[styles.statusChipText, { color: statusColor(status) }]}>{STATUS_LABEL[status]}</Text>
          </View>
        </View>

        {/* Text-only placement capsules. Four chips each carrying its own tiny
            glyph was the busiest thing on the card, and the labels already say
            Feed / Reels / Tv / Audio — the icons were decoration competing with
            the numbers below. */}
        <View style={styles.placeRow}>
          {placements.map((p) => (
            <View key={p} style={styles.placeChip}>
              <Text style={styles.placeChipText}>{p}</Text>
            </View>
          ))}
        </View>

        {/* Spend / budget */}
        <View style={styles.budgetRow}>
          <Text style={styles.budgetText}>{t('adManager.spendOf', { spent: fmtPrice(spent), budget: fmtPrice(budget) })}</Text>
          <Text style={styles.budgetPct}>{Math.round(pct * 100)}%</Text>
        </View>
        <View style={styles.budgetTrack}>
          <View style={[styles.budgetFill, { width: `${pct * 100}%` }]} />
        </View>

        {/* Number over label, in equal columns — the way iOS presents insights.
            The icon+text row read as a Material stat strip, and the eye / box-
            arrow / trend-line glyphs added nothing the words didn't. */}
        <View style={styles.statsRow}>
          {([
            [formatCount(impressions), t('adManager.statViews')],
            [formatCount(clicks), t('adManager.statClicks')],
            [`${ctr.toFixed(1)}%`, t('adManager.statCtr')],
          ] as const).map(([value, label]) => (
            <View key={label} style={styles.stat}>
              <Text style={styles.statValue}>{value}</Text>
              <Text style={styles.statLabel}>{label}</Text>
            </View>
          ))}
        </View>

        {(status === 'active' || status === 'paused') && (
          <View style={styles.cardActions}>
            {status === 'active' ? (
              <TouchableOpacity style={styles.cardActionGhost} disabled={busyId === c.id} onPress={() => doAction(c.id, pauseAdCampaign, t('adManager.errPause'))}>
                <Text style={styles.cardActionGhostText}>{t('adManager.pause')}</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.cardActionPrimary} disabled={busyId === c.id} onPress={() => doAction(c.id, resumeAdCampaign, t('adManager.errResume'))}>
                <Ionicons name="play" size={14} color={colors.text} />
                <Text style={styles.cardActionPrimaryText}>{t('adManager.resume')}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.cardActionGhost} disabled={busyId === c.id} onPress={() => confirmEnd(c)}>
              <Text style={styles.cardActionGhostText}>{t('adManager.end')}</Text>
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
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.backBtn} onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('account.adManager')}</Text>
          <View style={{ width: 40 }} />
        </View>

        {loading ? (
          <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
            {/* hint line */}
            <View style={{ gap: 6 }}>
              <SkeletonLine w="90%" h={10} />
              <SkeletonLine w="60%" h={10} />
            </View>
            {/* gradient create button placeholder */}
            <Skeleton width="100%" height={52} radius={RADIUS.lg} />
            {/* section title */}
            <SkeletonLine w="40%" h={11} />
            {/* campaign card skeletons */}
            <View style={styles.cards}>
              {[0, 1, 2].map((i) => (
                <View key={i} style={styles.card}>
                  <View style={styles.cardTitleRow}>
                    <SkeletonLine w="50%" h={15} />
                    <Skeleton width={64} height={18} radius={RADIUS.full} />
                  </View>
                  <View style={styles.placeRow}>
                    <Skeleton width={56} height={20} radius={RADIUS.full} />
                    <Skeleton width={56} height={20} radius={RADIUS.full} />
                  </View>
                  <View style={styles.budgetRow}>
                    <SkeletonLine w="45%" h={12} />
                    <SkeletonLine w={32} h={12} />
                  </View>
                  <Skeleton width="100%" height={6} radius={RADIUS.full} />
                  <View style={[styles.statsRow, { borderTopColor: colors.border }]}>
                    <SkeletonLine w={56} h={12} />
                    <SkeletonLine w={56} h={12} />
                    <SkeletonLine w={56} h={12} />
                  </View>
                </View>
              ))}
            </View>
          </ScrollView>
        ) : (
          <ScrollView
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />
            }
          >
            {campaigns.length === 0 ? (
              // ── Polished empty state: a soft hero instead of a bare icon ──────
              <View style={styles.hero}>
                <LinearGradient
                  colors={[colors.primary + '22', colors.primary + '05']}
                  style={styles.heroGlow}
                  start={{ x: 0.5, y: 0 }}
                  end={{ x: 0.5, y: 1 }}
                >
                  <LinearGradient colors={[colors.primary, colors.primaryDark ?? colors.primary]} style={styles.heroBadge}>
                    <Ionicons name="megaphone" size={34} color="#FFFFFF" />
                  </LinearGradient>
                  <Text style={styles.heroTitle}>{t('adManager.emptyTitle')}</Text>
                  <Text style={styles.heroSub}>{t('adManager.hint')}</Text>
                </LinearGradient>

                {/* Where your ads can run — makes the surface feel considered. */}
                <View style={styles.featureRow}>
                  {([
                    { icon: 'home-outline', label: t('adManager.featureFeed') },
                    { icon: 'play-circle-outline', label: t('adManager.featureReels') },
                    { icon: 'musical-notes-outline', label: t('adManager.featureMusic') },
                  ] as const).map((f) => (
                    <View key={f.label} style={styles.featureChip}>
                      <Ionicons name={f.icon} size={18} color={colors.primary} />
                      <Text style={styles.featureText}>{f.label}</Text>
                    </View>
                  ))}
                </View>

                <TouchableOpacity style={styles.createBtn} onPress={() => router.push('/ad-manager/create')} activeOpacity={0.85}>
                  <LinearGradient colors={[colors.primary, colors.primaryDark ?? colors.primary]} style={styles.createBtnInner}>
                    <Ionicons name="add" size={19} color="#FFFFFF" />
                    <Text style={styles.createBtnText}>{t('adManager.create')}</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <Text style={styles.hint}>{t('adManager.hint')}</Text>
                <TouchableOpacity style={styles.createBtn} onPress={() => router.push('/ad-manager/create')} activeOpacity={0.85}>
                  <LinearGradient colors={[colors.primary, colors.primaryDark ?? colors.primary]} style={styles.createBtnInner}>
                    <Text style={styles.createBtnText}>{t('adManager.create')}</Text>
                  </LinearGradient>
                </TouchableOpacity>
                <View style={styles.cards}>
                  <Text style={styles.sectionTitle}>{t('adManager.sectionCampaigns')}</Text>
                  {campaigns.map(renderCampaign)}
                </View>
              </>
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
  createBtnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },

  sectionTitle: {
    color: colors.textTertiary, fontSize: 11, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.8, paddingHorizontal: SPACING.xs,
  },
  cards: { gap: SPACING.sm },
  card: {
    backgroundColor: colors.surfaceLight, borderRadius: 18,
    // Hairline, not 1px: on a 3x screen a 1px border is a visibly chunky rule.
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    padding: SPACING.md, gap: SPACING.sm + 2,
  },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.sm },
  cardTitle: { color: colors.text, fontSize: 17, fontWeight: '600', letterSpacing: -0.4, flexShrink: 1 },
  statusChip: {
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.sm + 1, paddingVertical: 3,
  },
  statusChipText: { fontSize: 11, fontWeight: '600', letterSpacing: -0.1 },

  placeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  placeChip: {
    backgroundColor: colors.surfaceElevated, borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.sm + 2, paddingVertical: 4,
  },
  placeChipText: { color: colors.textSecondary, fontSize: 12, fontWeight: '500', letterSpacing: -0.1, textTransform: 'capitalize' },

  budgetRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  budgetText: { color: colors.text, fontSize: 13, fontWeight: '500', letterSpacing: -0.2 },
  budgetPct: { color: colors.textTertiary, fontSize: 13, fontWeight: '500', letterSpacing: -0.2 },
  // 4pt rather than 6: a thinner rule reads as a measure, not a control.
  budgetTrack: { height: 4, borderRadius: RADIUS.full, backgroundColor: colors.surfaceElevated, overflow: 'hidden' },
  budgetFill: { height: '100%', borderRadius: RADIUS.full, backgroundColor: colors.primary },

  statsRow: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
    paddingTop: SPACING.sm + 2,
  },
  // Equal columns rather than a gap-separated row, so the three figures line up
  // on a grid instead of drifting with each number's width.
  stat: { flex: 1, alignItems: 'center', gap: 1 },
  statValue: { color: colors.text, fontSize: 17, fontWeight: '600', letterSpacing: -0.4 },
  statLabel: { color: colors.textTertiary, fontSize: 11, fontWeight: '500', letterSpacing: -0.05 },

  cardActions: { flexDirection: 'row', gap: SPACING.sm },
  cardActionPrimary: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: colors.primary, borderRadius: RADIUS.full,
    paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md, flex: 1,
  },
  // '#fff', not colors.text: on the light theme colors.text is near-black, which
  // on the orange fill was dark-on-orange. The label sits on a brand-coloured
  // button in both themes, so it's fixed white.
  cardActionPrimaryText: { color: '#fff', fontSize: 14, fontWeight: '600', letterSpacing: -0.2 },
  cardActionGhost: {
    alignItems: 'center', justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderStrong, borderRadius: RADIUS.full,
    paddingVertical: SPACING.sm + 1, paddingHorizontal: SPACING.md, flex: 1,
  },
  // Full-strength text: at textSecondary these read as disabled, and Pause / End
  // are the card's only real controls.
  cardActionGhostText: { color: colors.text, fontSize: 14, fontWeight: '600', letterSpacing: -0.2 },

  empty: { alignItems: 'center', paddingTop: SPACING.xxl, gap: SPACING.sm, paddingHorizontal: SPACING.lg },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  emptySub: { color: colors.textSecondary, fontSize: 13, textAlign: 'center' },

  // Polished empty-state hero
  hero: { gap: SPACING.lg, paddingTop: SPACING.sm },
  heroGlow: {
    alignItems: 'center', gap: SPACING.sm,
    borderRadius: RADIUS.xl, paddingVertical: SPACING.xl, paddingHorizontal: SPACING.lg,
    borderWidth: 1, borderColor: colors.border,
  },
  heroBadge: {
    width: 74, height: 74, borderRadius: 37, alignItems: 'center', justifyContent: 'center',
    marginBottom: SPACING.xs,
    shadowColor: colors.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.4, shadowRadius: 14, elevation: 8,
  },
  heroTitle: { color: colors.text, fontSize: 20, fontWeight: '900', textAlign: 'center' },
  heroSub: { color: colors.textSecondary, fontSize: 13, lineHeight: 19, textAlign: 'center', paddingHorizontal: SPACING.sm },
  featureRow: { flexDirection: 'row', gap: SPACING.sm },
  featureChip: {
    flex: 1, alignItems: 'center', gap: 6,
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: colors.border, paddingVertical: SPACING.md,
  },
  featureText: { color: colors.textSecondary, fontSize: 11.5, fontWeight: '700' },
});
