import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, ActivityIndicator, Switch, RefreshControl,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState, useCallback, useRef } from 'react';
import PagerView from 'react-native-pager-view';
import { supabase } from '../lib/supabase';
import { useProfile } from '../contexts/ProfileContext';
import BadgeEmblem from '../components/BadgeEmblem';
import {
  BADGES, CATEGORY_META, CATEGORY_ORDER, THEME_OPTIONS, RING_STYLE_OPTIONS,
  isUnlocked, tierLabel, rawTier,
  evaluateBadges, fetchBadgeState, computeMetrics,
  type Tier, type BadgeState, type BadgeMetrics, type EvalResult, type BadgeDef, type BadgeCategory,
} from '../lib/badges';
import { COLORS, SPACING, RADIUS } from '../constants/theme';

// Points needed for each emblem tier (mirrors computeEmblemTier).
const TIER_THRESH: [Tier, number][] = [['bronze', 2], ['silver', 4], ['gold', 8], ['diamond', 16]];

type Status =
  | { kind: 'earned' }
  | { kind: 'locked' }
  | { kind: 'progress'; cur: number; target: number; unit: string };

// In-progress hint for a not-yet-earned, unlocked badge.
function badgeStatus(def: BadgeDef, m: BadgeMetrics | null, held: Set<string>): Status {
  if (def.locked) return { kind: 'locked' };
  if (held.has(def.key)) return { kind: 'earned' };
  const cur = (n: number, target: number, unit: string): Status => ({ kind: 'progress', cur: Math.min(n, target), target, unit });
  if (!m) return { kind: 'progress', cur: 0, target: 1, unit: '' };
  switch (def.key) {
    case 'login_bronze':  return cur(m.loginStreak, 3, 'day streak');
    case 'login_silver':  return cur(m.loginStreak, 7, 'day streak');
    case 'login_gold':    return cur(m.loginStreak, 14, 'day streak');
    case 'login_diamond': return cur(m.loginStreak, 30, 'day streak');
    case 'daily_like_bronze': return cur(m.todayLikes, 15, 'likes today');
    case 'daily_like_silver': return cur(m.likeStreak, 3, 'day streak');
    case 'daily_like_gold':   return cur(m.likeStreak, 7, 'day streak');
    case 'posts_bronze': return cur(m.publicPosts, 1, 'public posts');
    case 'posts_silver': return cur(m.publicPosts, 5, 'public posts');
    case 'music_streaming_bronze': return cur(m.musicMinutesToday, 10, 'min today');
    case 'music_streaming_silver': return cur(m.musicMinutesToday, 20, 'min today');
    case 'music_streaming_gold':   return cur(m.musicMinutesToday, 30, 'min today');
    case 'comments_bronze': return cur(m.todayComments, 1, 'today');
    case 'comments_silver': return cur(m.todayComments, 2, 'today');
    default: return { kind: 'progress', cur: 0, target: 1, unit: '' };
  }
}

export default function BadgesScreen() {
  const router = useRouter();
  const { profile, update } = useProfile();
  const [state, setState] = useState<BadgeState | null>(null);
  const [evalRes, setEvalRes] = useState<EvalResult | null>(null);
  const [held, setHeld] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const pagerRef = useRef<PagerView>(null);

  const load = useCallback(async () => {
    const [s, e] = await Promise.all([fetchBadgeState(), evaluateBadges({ silent: true })]);
    setState(s);
    setEvalRes(e);
    setHeld(new Set(e.held));
    setLoading(false);
    setRefreshing(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const emblemTier = evalRes?.tier ?? rawTier(profile);
  const points = evalRes?.points ?? 0;
  const metrics = state ? computeMetrics(state) : null;
  const badgeShow = profile?.badge_show !== false;
  const next = TIER_THRESH.find(([, p]) => p > points);

  async function persist(patch: { badge_show?: boolean; profile_theme?: string; story_ring_style?: string }) {
    update(patch); // optimistic — emblem/ring/theme update everywhere immediately
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) await supabase.from('profiles').update(patch).eq('id', user.id);
    } catch {}
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ gestureEnabled: false }} />
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={COLORS.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Badges</Text>
        <View style={{ width: 40 }} />
      </View>

      <PagerView
        ref={pagerRef}
        style={styles.pager}
        initialPage={1}
        onPageSelected={(e) => {
          if (e.nativeEvent.position === 0) {
            if (router.canGoBack()) router.back();
            else pagerRef.current?.setPageWithoutAnimation(1);
          }
        }}
      >
        <View key="dismiss" style={styles.dismissPage} />
        <View key="content" style={styles.page}>
          {loading ? (
            <View style={styles.center}><ActivityIndicator color={COLORS.primary} /></View>
          ) : (
            <ScrollView
              contentContainerStyle={styles.scroll}
              showsVerticalScrollIndicator={false}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={COLORS.primary} />}
            >
              {/* Hero: current emblem + tier + points */}
              <LinearGradient colors={['#160B05', '#0C0703']} style={styles.hero}>
                {emblemTier ? (
                  <BadgeEmblem tier={emblemTier} size={66} />
                ) : (
                  <View style={styles.heroEmpty}>
                    <Ionicons name="ribbon-outline" size={32} color={COLORS.textTertiary} />
                  </View>
                )}
                <Text style={styles.heroTier}>{emblemTier ? `${tierLabel(emblemTier)} Status` : 'No badge yet'}</Text>
                <Text style={styles.heroSub}>
                  {emblemTier
                    ? `${points} ${points === 1 ? 'point' : 'points'}${next ? ` · ${next[1] - points} to ${tierLabel(next[0])}` : ' · top tier!'}`
                    : 'Earn badges below to unlock your status emblem.'}
                </Text>
              </LinearGradient>

              {/* Show / hide emblem */}
              <View style={styles.card}>
                <View style={styles.toggleRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.toggleLabel}>Show badge emblem</Text>
                    <Text style={styles.toggleSub}>Display your status next to your name. Off hides it from everyone.</Text>
                  </View>
                  <Switch
                    value={badgeShow}
                    onValueChange={(v) => persist({ badge_show: v })}
                    trackColor={{ false: COLORS.border, true: COLORS.primary + '88' }}
                    thumbColor={badgeShow ? COLORS.primary : COLORS.textTertiary}
                  />
                </View>
              </View>

              {/* Customization — story ring + profile theme (gated by tier) */}
              <Text style={styles.sectionTitle}>Customization</Text>
              <View style={styles.card}>
                <Text style={styles.pickerLabel}>Story ring</Text>
                <View style={styles.chipRow}>
                  {RING_STYLE_OPTIONS.map((opt) => {
                    const unlocked = isUnlocked(opt.minTier, emblemTier);
                    const selected = (profile?.story_ring_style ?? 'default') === opt.key;
                    return (
                      <TouchableOpacity
                        key={opt.key}
                        disabled={!unlocked}
                        onPress={() => persist({ story_ring_style: opt.key })}
                        style={[styles.chip, selected && styles.chipSelected, !unlocked && styles.chipLocked]}
                      >
                        <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{opt.label}</Text>
                        {!unlocked && <Text style={styles.chipLock}>🔒 {tierLabel(opt.minTier)}</Text>}
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <View style={styles.innerDivider} />

                <Text style={styles.pickerLabel}>Profile theme</Text>
                <View style={styles.chipRow}>
                  {THEME_OPTIONS.map((opt) => {
                    const unlocked = isUnlocked(opt.minTier, emblemTier);
                    const selected = (profile?.profile_theme ?? 'default') === opt.key;
                    return (
                      <TouchableOpacity
                        key={opt.key}
                        disabled={!unlocked}
                        onPress={() => persist({ profile_theme: opt.key })}
                        style={[styles.chip, selected && styles.chipSelected, !unlocked && styles.chipLocked]}
                      >
                        <LinearGradient colors={opt.banner} style={styles.themeDot} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} />
                        <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{opt.label}</Text>
                        {!unlocked && <Text style={styles.chipLock}>🔒 {tierLabel(opt.minTier)}</Text>}
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              {/* Catalog grouped by category */}
              <Text style={styles.sectionTitle}>All badges</Text>
              {CATEGORY_ORDER.map((cat) => (
                <CategoryCard key={cat} category={cat} metrics={metrics} held={held} />
              ))}

              <Text style={styles.footnote}>
                Each badge is worth Bronze=1, Silver=2, Gold=4, Diamond=8 points (highest tier per category). Your emblem
                unlocks at 2 / 4 / 8 / 16 total points for Bronze / Silver / Gold / Diamond. Streak badges revert if you break
                the streak; permanent ones stay. Community, Ads and App Sharing are coming soon.
              </Text>
            </ScrollView>
          )}
        </View>
      </PagerView>
    </View>
  );
}

function CategoryCard({ category, metrics, held }: { category: BadgeCategory; metrics: BadgeMetrics | null; held: Set<string> }) {
  const meta = CATEGORY_META[category];
  const defs = BADGES.filter((b) => b.category === category);
  return (
    <View style={styles.catCard}>
      <View style={styles.catHead}>
        <Ionicons name={meta.icon as any} size={16} color={COLORS.primary} />
        <Text style={styles.catTitle}>{meta.label}</Text>
      </View>
      {defs.map((def) => {
        const st = badgeStatus(def, metrics, held);
        return (
          <View key={def.key} style={styles.badgeRow}>
            <BadgeEmblem tier={def.tier} size={24} style={st.kind === 'earned' ? undefined : styles.dimmed} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.badgeTitle, st.kind !== 'earned' && styles.badgeTitleMuted]}>{tierLabel(def.tier)}</Text>
              <Text style={styles.badgeCriteria}>{def.criteria}</Text>
            </View>
            {st.kind === 'earned' ? (
              <View style={styles.earnedPill}>
                <Ionicons name="checkmark-circle" size={13} color={COLORS.success} />
                <Text style={styles.earnedText}>{def.permanent ? 'Earned · permanent' : 'Earned'}</Text>
              </View>
            ) : st.kind === 'locked' ? (
              <Text style={styles.lockedText}>Coming soon</Text>
            ) : (
              <Text style={styles.progressText}>{st.cur}/{st.target}{st.unit ? ` ${st.unit}` : ''}</Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  pager: { flex: 1 },
  page: { flex: 1 },
  dismissPage: { flex: 1, backgroundColor: COLORS.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm,
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: COLORS.border,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: COLORS.text, fontSize: 18, fontWeight: '800' },

  scroll: { padding: SPACING.md, paddingBottom: SPACING.xxl + SPACING.lg, gap: SPACING.md },

  hero: {
    alignItems: 'center', gap: 6,
    borderRadius: RADIUS.lg, borderWidth: 1, borderColor: COLORS.border,
    paddingVertical: SPACING.lg, paddingHorizontal: SPACING.md,
  },
  heroEmpty: {
    width: 66, height: 66, borderRadius: 33,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: COLORS.surfaceElevated, borderWidth: 1, borderColor: COLORS.border,
  },
  heroTier: { color: COLORS.text, fontSize: 18, fontWeight: '800', marginTop: 4 },
  heroSub: { color: COLORS.textSecondary, fontSize: 13, textAlign: 'center', lineHeight: 18 },

  card: {
    backgroundColor: COLORS.surfaceLight, borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: COLORS.border, padding: SPACING.md,
  },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  toggleLabel: { color: COLORS.text, fontSize: 15, fontWeight: '600' },
  toggleSub: { color: COLORS.textSecondary, fontSize: 12, marginTop: 2, lineHeight: 16 },

  sectionTitle: {
    color: COLORS.textTertiary, fontSize: 11, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.8, paddingHorizontal: SPACING.xs, marginTop: SPACING.xs,
  },
  pickerLabel: { color: COLORS.text, fontSize: 14, fontWeight: '600', marginBottom: SPACING.sm },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: COLORS.surfaceElevated, borderRadius: RADIUS.full,
    borderWidth: 1, borderColor: COLORS.border,
    paddingVertical: SPACING.xs + 2, paddingHorizontal: SPACING.md,
  },
  chipSelected: { borderColor: COLORS.primary, backgroundColor: COLORS.primary + '1A' },
  chipLocked: { opacity: 0.5 },
  chipText: { color: COLORS.text, fontSize: 13, fontWeight: '600' },
  chipTextSelected: { color: COLORS.primaryLight },
  chipLock: { color: COLORS.textTertiary, fontSize: 11 },
  themeDot: { width: 16, height: 16, borderRadius: 8, borderWidth: 1, borderColor: COLORS.border },
  innerDivider: { height: 0.5, backgroundColor: COLORS.border, marginVertical: SPACING.md },

  catCard: {
    backgroundColor: COLORS.surfaceLight, borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: COLORS.border, padding: SPACING.md, gap: SPACING.sm,
  },
  catHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  catTitle: { color: COLORS.text, fontSize: 15, fontWeight: '700' },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  dimmed: { opacity: 0.4 },
  badgeTitle: { color: COLORS.text, fontSize: 13, fontWeight: '700' },
  badgeTitleMuted: { color: COLORS.textSecondary },
  badgeCriteria: { color: COLORS.textTertiary, fontSize: 12, marginTop: 1 },
  earnedPill: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  earnedText: { color: COLORS.success, fontSize: 12, fontWeight: '600' },
  lockedText: { color: COLORS.textTertiary, fontSize: 12, fontStyle: 'italic' },
  progressText: { color: COLORS.textSecondary, fontSize: 12, fontWeight: '600' },

  footnote: { color: COLORS.textTertiary, fontSize: 11, lineHeight: 16, paddingHorizontal: SPACING.xs, marginTop: SPACING.sm },
});
