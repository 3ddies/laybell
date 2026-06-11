import {
  View, Text, StyleSheet, TouchableOpacity, Image, Modal,
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
  BADGES, CATEGORY_META, CATEGORY_ORDER, THEME_OPTIONS, THEME_RING_STYLE,
  isUnlocked, tierLabel, rawTier, badgeRingColors,
  evaluateBadges, fetchBadgeState, computeMetrics,
  type Tier, type BadgeState, type BadgeMetrics, type EvalResult, type BadgeDef, type BadgeCategory,
} from '../lib/badges';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../constants/theme';

// Points needed for each emblem tier (mirrors computeEmblemTier).
const TIER_THRESH: [Tier, number][] = [['bronze', 2], ['silver', 4], ['gold', 8], ['diamond', 16]];

const DEFAULT_BANNER: readonly [string, string] = ['#1A0D05', '#0B0603'];

// Ring colors for a preview — applies the style to the given tier's base colors
// WITHOUT the unlock gate, so locked styles can be previewed as motivation.
function previewRingColors(tier: Tier | null, styleKey: string): readonly [string, string] {
  const base = badgeRingColors(tier);
  if (styleKey === 'solid') return [base[0], base[0]];
  if (styleKey === 'shine') return [base[1], base[0]];
  return base;
}

// Tier ranking so the preview can resolve the highest tier implied by the
// currently-selected ring + theme (each customization belongs to a tier).
const TIER_RANK: Record<Tier, number> = { bronze: 1, silver: 2, gold: 3, diamond: 4 };
function rankOf(t: Tier | null): number { return t ? TIER_RANK[t] : 0; }
function maxTier(...tiers: (Tier | null)[]): Tier | null {
  return tiers.reduce<Tier | null>((best, t) => (rankOf(t) > rankOf(best) ? t : best), null);
}

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
    case 'login_bronze':  return cur(m.loginStreak, 3, 'days');
    case 'login_silver':  return cur(m.loginStreak, 7, 'days');
    case 'login_gold':    return cur(m.loginStreak, 14, 'days');
    case 'login_diamond': return cur(m.loginStreak, 30, 'days');
    case 'daily_like_bronze': return cur(m.todayLikes, 15, 'today');
    case 'daily_like_silver': return cur(m.likeStreak, 3, 'days');
    case 'daily_like_gold':   return cur(m.likeStreak, 7, 'days');
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
  const [showPreview, setShowPreview] = useState(false);
  // category → most recent earned_at (ms). Drives the All-badges ordering so the
  // user's latest achievements float to the top.
  const [recentByCat, setRecentByCat] = useState<Record<string, number>>({});
  const pagerRef = useRef<PagerView>(null);

  // Live-preview theme for the hero emblem. Seeded from the saved value and
  // re-synced when it changes (i.e. after applying an unlocked theme). Tapping a
  // LOCKED theme only updates the preview here — it never persists — so the user
  // can see what they're working toward. The ring style rides along with the theme.
  const [previewTheme, setPreviewTheme] = useState<string>(profile?.profile_theme ?? 'default');
  useEffect(() => { setPreviewTheme(profile?.profile_theme ?? 'default'); }, [profile?.profile_theme]);

  const load = useCallback(async () => {
    // evaluateBadges may insert newly-earned rows (earned_at = now), so read the
    // per-category recency AFTER it resolves to reflect the latest achievements.
    const [s, e, { data: { user } }] = await Promise.all([
      fetchBadgeState(), evaluateBadges({ silent: true }), supabase.auth.getUser(),
    ]);
    setState(s);
    setEvalRes(e);
    setHeld(new Set(e.held));
    if (user) {
      const { data: ub } = await supabase.from('user_badges').select('category, earned_at').eq('user_id', user.id);
      const map: Record<string, number> = {};
      for (const r of (ub ?? []) as { category: string; earned_at: string }[]) {
        const t = new Date(r.earned_at).getTime();
        if (!map[r.category] || t > map[r.category]) map[r.category] = t;
      }
      setRecentByCat(map);
    }
    setLoading(false);
    setRefreshing(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const emblemTier = evalRes?.tier ?? rawTier(profile);
  const points = evalRes?.points ?? 0;
  const metrics = state ? computeMetrics(state) : null;
  const badgeShow = profile?.badge_show !== false;
  const next = TIER_THRESH.find(([, p]) => p > points);

  // The previewed theme's tier IS the badge being shown (the theme doubles as the
  // chosen display badge). Default theme → your full earned tier. A specific theme
  // shows that tier's emblem + ring, so a higher-tier user can pick a lower badge.
  const themeOpt = THEME_OPTIONS.find(o => o.key === previewTheme);
  // Default theme → no badge shown (matches the public profile); a specific theme
  // previews that tier's badge.
  const previewTier = themeOpt?.minTier ?? null;
  // Locked = above what you've actually earned (aspirational preview, can't apply).
  const isPreviewing = themeOpt ? !isUnlocked(themeOpt.minTier, emblemTier) : false;
  // Ring style is bundled into the theme now.
  const previewRingStyle = THEME_RING_STYLE[previewTheme] ?? 'default';

  // Resolved colors for the live preview avatar + hero banner.
  const previewRingCols = previewRingColors(previewTier, previewRingStyle);
  const previewBanner = themeOpt?.banner ?? DEFAULT_BANNER;
  // The avatar glow matches the previewed tier's ring color (falls back to the
  // brand color before any badge is earned).
  const previewGlow = previewTier ? badgeRingColors(previewTier)[0] : COLORS.primary;
  // Progress meter is tinted by the user's CURRENT tier (their real status), not
  // the previewed one — it reflects actual progress toward the next tier.
  const progressCols = emblemTier ? badgeRingColors(emblemTier) : GRADIENTS.primaryWarm;

  // Categories with the most recent achievement first; ties (and categories with
  // no badge yet) keep their default order, so they settle below. Array.sort is
  // stable, which preserves that fallback ordering.
  const orderedCats = [...CATEGORY_ORDER].sort((a, b) => (recentByCat[b] ?? 0) - (recentByCat[a] ?? 0));

  // A single theme chip — lights up in its own tier color only when selected.
  const themeChip = (opt: typeof THEME_OPTIONS[number]) => {
    const unlocked = isUnlocked(opt.minTier, emblemTier);
    const selected = previewTheme === opt.key;
    const accent = opt.minTier ? badgeRingColors(opt.minTier)[0] : COLORS.primary;
    const isDiamond = opt.key === 'diamond';
    return (
      <TouchableOpacity
        key={opt.key}
        activeOpacity={0.7}
        onPress={() => { setPreviewTheme(opt.key); if (unlocked) persist({ profile_theme: opt.key }); }}
        style={[
          styles.chip,
          isDiamond && styles.chipTall,
          selected && { borderColor: accent, backgroundColor: accent + '22' },
          !unlocked && styles.chipLocked,
        ]}
      >
        <LinearGradient colors={opt.banner as any} style={styles.themeDot} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} />
        <Text style={[styles.chipText, isDiamond && styles.chipTextDiamond, selected && { color: accent, fontWeight: '700' }]}>{opt.label}</Text>
        {selected && unlocked && <Ionicons name="checkmark-circle" size={15} color={accent} />}
        {!unlocked && <Ionicons name="lock-closed" size={12} color={COLORS.textTertiary} />}
      </TouchableOpacity>
    );
  };
  const avatarUrl = profile?.avatar_url ?? null;
  const avatarLetter = (profile?.display_name || profile?.username || '?').charAt(0).toUpperCase();

  async function persist(patch: { badge_show?: boolean; profile_theme?: string }) {
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
              {/* Hero: live preview of the user's circle emblem — reflects the
                  currently-tapped ring style + theme (incl. locked, for motivation). */}
              <LinearGradient colors={previewBanner as any} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.hero}>
                <View style={[styles.previewWrap, { shadowColor: previewGlow }]}>
                  <LinearGradient colors={previewRingCols as any} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.previewRing}>
                    <View style={styles.previewAvatarGap}>
                      {avatarUrl ? (
                        <Image source={{ uri: avatarUrl }} style={styles.previewAvatar} />
                      ) : (
                        <LinearGradient colors={GRADIENTS.primary} style={styles.previewAvatar}>
                          <Text style={styles.previewAvatarText}>{avatarLetter}</Text>
                        </LinearGradient>
                      )}
                    </View>
                  </LinearGradient>
                  {previewTier && (
                    <View style={styles.previewEmblem}><BadgeEmblem tier={previewTier} size={26} /></View>
                  )}
                </View>
                {previewTier ? (
                  <View style={styles.heroTitleWrap}>
                    <Text style={styles.heroTierName}>{tierLabel(previewTier)}</Text>
                    <Text style={styles.heroTierWord}>{isPreviewing ? 'Preview' : 'Badge'}</Text>
                  </View>
                ) : (
                  <Text style={styles.heroTier}>{emblemTier ? 'No badge shown' : 'No badge yet'}</Text>
                )}
                <Text style={styles.heroSub}>
                  {emblemTier
                    ? `${points} ${points === 1 ? 'point' : 'points'}${next ? ` · ${next[1] - points} to ${tierLabel(next[0])}` : ' · top tier!'}`
                    : 'Earn badges below to unlock your status emblem.'}
                </Text>
                {/* Progress toward the next tier — a slim gradient meter. */}
                {next && (
                  <View style={styles.heroBarTrack}>
                    <LinearGradient
                      colors={progressCols as any}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 0 }}
                      style={[styles.heroBarFill, { width: `${Math.max(6, Math.min(100, (points / next[1]) * 100))}%` }]}
                    />
                  </View>
                )}
              </LinearGradient>

              {/* Customization — profile theme (banner + matching story ring), gated by tier */}
              <Text style={styles.sectionTitle}>Customization</Text>
              <Text style={styles.sectionHint}>Tap a theme to preview its banner + story ring on your emblem above. Unlock by reaching its tier.</Text>
              <View style={styles.card}>
                <Text style={styles.pickerLabel}>Badges</Text>
                {/* Rows reflect the importance hierarchy: Default/Bronze/Silver
                    together, then Gold alone, then Diamond alone. */}
                <View style={styles.chipRows}>
                  <View style={styles.chipRow}>
                    {THEME_OPTIONS.filter((o) => o.key === 'default' || o.key === 'bronze' || o.key === 'silver').map(themeChip)}
                  </View>
                  <View style={styles.chipRow}>
                    {THEME_OPTIONS.filter((o) => o.key === 'gold').map(themeChip)}
                  </View>
                  <View style={styles.chipRow}>
                    {THEME_OPTIONS.filter((o) => o.key === 'diamond').map(themeChip)}
                  </View>
                </View>

                {/* See the previewed theme applied to a mock of your profile page. */}
                <TouchableOpacity style={styles.previewPageBtn} activeOpacity={0.85} onPress={() => setShowPreview(true)}>
                  <Ionicons name="eye-outline" size={18} color={COLORS.text} />
                  <Text style={styles.previewPageBtnText}>Preview page</Text>
                </TouchableOpacity>
              </View>

              {/* Catalog grouped by category — most recently earned categories first. */}
              <Text style={styles.sectionTitle}>All badges</Text>
              {orderedCats.map((cat) => (
                <CategoryCard key={cat} category={cat} metrics={metrics} held={held} />
              ))}

              <Text style={styles.footnote}>
                Each badge is worth Bronze=1, Silver=2, Gold=4, Diamond=8 points (highest tier per category). Your emblem
                unlocks at 2 / 4 / 8 / 16 total points for Bronze / Silver / Gold / Diamond. Streak badges revert if you break
                the streak; permanent ones stay. Community, Ads and App Sharing are coming soon.
              </Text>

              {/* Show / hide emblem — moved to the bottom. */}
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
            </ScrollView>
          )}
        </View>
      </PagerView>

      {/* Page preview — the previewed theme (banner + ring + emblem) on a mock of
          the user's profile header, exactly as other people would see it. */}
      <Modal visible={showPreview} animationType="slide" transparent onRequestClose={() => setShowPreview(false)}>
        <View style={styles.modalRoot}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Page preview</Text>
            <TouchableOpacity onPress={() => setShowPreview(false)} hitSlop={10}>
              <Ionicons name="close" size={26} color={COLORS.text} />
            </TouchableOpacity>
          </View>
          <Text style={styles.modalSub}>
            How your profile looks with the {themeOpt?.label ?? 'Default'} theme — what other people see.
          </Text>

          <View style={styles.ppCard}>
            <LinearGradient colors={previewBanner as any} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.ppBanner}>
              <View style={[styles.ppRingWrap, { shadowColor: previewGlow }]}>
                <LinearGradient colors={previewRingCols as any} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.ppRing}>
                  <View style={styles.ppAvatarGap}>
                    {avatarUrl ? (
                      <Image source={{ uri: avatarUrl }} style={styles.ppAvatar} />
                    ) : (
                      <LinearGradient colors={GRADIENTS.primary} style={styles.ppAvatar}>
                        <Text style={styles.ppAvatarText}>{avatarLetter}</Text>
                      </LinearGradient>
                    )}
                  </View>
                </LinearGradient>
                {badgeShow && previewTier && (
                  <View style={styles.ppEmblem}><BadgeEmblem tier={previewTier} size={22} /></View>
                )}
              </View>
              <View style={styles.ppStats}>
                {['Posts', 'Followers', 'Following'].map((l) => (
                  <View key={l} style={styles.ppStatItem}>
                    <View style={styles.ppStatBar} />
                    <Text style={styles.ppStatLabel}>{l}</Text>
                  </View>
                ))}
              </View>
            </LinearGradient>
            <View style={styles.ppInfo}>
              <View style={styles.ppNameRow}>
                <Text style={styles.ppName} numberOfLines={1}>{profile?.display_name ?? 'Your name'}</Text>
                {badgeShow && previewTier && <BadgeEmblem tier={previewTier} size={17} />}
              </View>
              <Text style={styles.ppUsername} numberOfLines={1}>@{profile?.username ?? 'username'}</Text>
              {!!profile?.bio && <Text style={styles.ppBio} numberOfLines={2}>{profile.bio}</Text>}
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function CategoryCard({ category, metrics, held }: { category: BadgeCategory; metrics: BadgeMetrics | null; held: Set<string> }) {
  const meta = CATEGORY_META[category];
  const defs = BADGES.filter((b) => b.category === category);
  // The user's current standing in this category = the highest tier they hold
  // here (null → no badge yet, shown as an empty placeholder).
  const earned = defs.filter((d) => held.has(d.key));
  const currentTier = earned.length ? maxTier(...earned.map((d) => d.tier)) : null;
  return (
    <View style={styles.catCard}>
      <View style={styles.catHead}>
        {currentTier ? (
          <BadgeEmblem tier={currentTier} size={50} />
        ) : (
          <View style={styles.catEmblemEmpty}>
            <Ionicons name={meta.icon as any} size={24} color={COLORS.textTertiary} />
          </View>
        )}
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
            <View style={styles.badgeStatus}>
              {st.kind === 'earned' ? (
                <View style={styles.earnedCheck}>
                  <Ionicons name="checkmark-sharp" size={16} color="#fff" />
                </View>
              ) : st.kind === 'locked' ? (
                <Text style={styles.lockedText}>Coming soon</Text>
              ) : (
                <Text style={styles.progressText}>{def.key === 'daily_like_bronze' ? st.cur : `${st.cur}/${st.target}`}</Text>
              )}
            </View>
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
    borderBottomWidth: 0.5, borderBottomColor: 'rgba(255,255,255,0.07)',
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: COLORS.text, fontSize: 18, fontWeight: '800', letterSpacing: -0.3 },

  scroll: { padding: SPACING.md, paddingBottom: SPACING.xxl + SPACING.lg, gap: SPACING.md },

  hero: {
    alignItems: 'center', gap: 6,
    borderRadius: RADIUS.xl, borderWidth: 1, borderColor: 'rgba(242,101,34,0.22)',
    paddingVertical: SPACING.lg + 2, paddingHorizontal: SPACING.md,
  },
  // Live preview avatar (story-ring look: gradient ring → gap → avatar).
  previewWrap: {
    width: 94, height: 94, alignItems: 'center', justifyContent: 'center', marginBottom: 2,
    shadowColor: COLORS.primary, shadowOpacity: 0.5, shadowRadius: 15, shadowOffset: { width: 0, height: 0 },
    elevation: 10,
  },
  previewRing: { width: 94, height: 94, borderRadius: 47, alignItems: 'center', justifyContent: 'center' },
  previewAvatarGap: {
    width: 86, height: 86, borderRadius: 43, backgroundColor: '#0B0603',
    alignItems: 'center', justifyContent: 'center',
  },
  previewAvatar: { width: 78, height: 78, borderRadius: 39, alignItems: 'center', justifyContent: 'center' },
  previewAvatarText: { color: COLORS.text, fontSize: 30, fontWeight: '800' },
  previewEmblem: {
    position: 'absolute', bottom: -1, right: -1,
    backgroundColor: '#0B0603', borderRadius: RADIUS.full, padding: 2,
  },
  heroTier: { color: COLORS.text, fontSize: 20, fontWeight: '800', marginTop: 8, letterSpacing: -0.3 },
  heroTitleWrap: { alignItems: 'center', marginTop: 8 },
  heroTierName: { color: COLORS.text, fontSize: 32, fontWeight: '900', letterSpacing: -0.6 },
  heroTierWord: { color: COLORS.textSecondary, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1.5, marginTop: 1 },
  heroSub: { color: COLORS.textSecondary, fontSize: 13, textAlign: 'center', lineHeight: 18 },
  heroBarTrack: {
    width: '70%', height: 6, borderRadius: RADIUS.full, marginTop: SPACING.sm,
    backgroundColor: 'rgba(255,255,255,0.10)', overflow: 'hidden',
  },
  heroBarFill: { height: '100%', borderRadius: RADIUS.full },

  card: {
    backgroundColor: COLORS.surfaceLight, borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)', padding: SPACING.md,
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  toggleLabel: { color: COLORS.text, fontSize: 15, fontWeight: '700' },
  toggleSub: { color: COLORS.textSecondary, fontSize: 12, marginTop: 2, lineHeight: 16 },

  sectionTitle: {
    color: COLORS.textTertiary, fontSize: 11, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.8, paddingHorizontal: SPACING.xs, marginTop: SPACING.xs,
  },
  sectionHint: { color: COLORS.textTertiary, fontSize: 12, lineHeight: 16, paddingHorizontal: SPACING.xs, marginTop: -SPACING.sm },
  pickerLabel: { color: COLORS.text, fontSize: 24, fontWeight: '900', letterSpacing: -0.4, marginBottom: SPACING.sm },
  chipRows: { gap: SPACING.sm },
  chipRow: { flexDirection: 'row', gap: SPACING.sm },
  chip: {
    flex: 1,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    backgroundColor: COLORS.surfaceElevated, borderRadius: RADIUS.full,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
    paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md - 2,
  },
  // Diamond — taller to emphasize the peak reward; tighter gap pulls the swatch
  // closer to the label.
  // Diamond — taller, more squared, and inset on the sides (narrower than Gold)
  // to set it apart as the peak reward.
  chipTall: {
    paddingVertical: SPACING.md + 5, gap: 4,
    backgroundColor: 'rgba(103,232,249,0.07)',
    borderRadius: 24, marginHorizontal: SPACING.lg,
  },
  chipLocked: { opacity: 0.7 },
  chipText: { color: COLORS.text, fontSize: 13.5, fontWeight: '600' },
  chipTextDiamond: {
    color: '#CFF6FF', fontSize: 18.5, fontWeight: '900',
    textTransform: 'uppercase', letterSpacing: 0.3,
  },
  themeDot: { width: 20, height: 20, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' },
  innerDivider: { height: 0.5, backgroundColor: 'rgba(255,255,255,0.07)', marginVertical: SPACING.md },

  catCard: {
    backgroundColor: COLORS.surfaceLight, borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)', padding: SPACING.md, gap: SPACING.sm,
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  catHead: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm + 2, marginBottom: SPACING.xs },
  catEmblemEmpty: {
    width: 50, height: 50, borderRadius: RADIUS.full,
    backgroundColor: COLORS.surfaceElevated, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)',
    alignItems: 'center', justifyContent: 'center',
  },
  catTitle: { color: COLORS.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.3 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  // Fixed, centered status column so the checks / progress numbers line up
  // vertically across every row in a category.
  badgeStatus: { minWidth: 52, alignItems: 'center', justifyContent: 'center' },
  dimmed: { opacity: 0.6 },
  badgeTitle: { color: COLORS.text, fontSize: 13, fontWeight: '700' },
  badgeTitleMuted: { color: COLORS.textSecondary },
  badgeCriteria: { color: COLORS.textSecondary, fontSize: 13, lineHeight: 17, marginTop: 2 },
  // Earned badges show just a checkmark in a rounded green disc with a soft glow.
  earnedCheck: {
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: COLORS.success, alignItems: 'center', justifyContent: 'center',
    shadowColor: COLORS.success, shadowOpacity: 0.6, shadowRadius: 7, shadowOffset: { width: 0, height: 0 },
    elevation: 5,
  },
  lockedText: { color: COLORS.textTertiary, fontSize: 12, fontStyle: 'italic' },
  progressText: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '700' },

  footnote: { color: COLORS.textTertiary, fontSize: 11, lineHeight: 16, paddingHorizontal: SPACING.xs, marginTop: SPACING.sm },

  previewPageBtn: {
    marginTop: SPACING.sm, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: SPACING.sm + 2, borderRadius: RADIUS.full,
    backgroundColor: COLORS.surfaceElevated, borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
  },
  previewPageBtnText: { color: COLORS.text, fontSize: 14, fontWeight: '700', letterSpacing: 0.2 },

  // ── Page-preview modal ──
  modalRoot: {
    flex: 1, backgroundColor: COLORS.background,
    paddingTop: SPACING.xxl + SPACING.sm, paddingHorizontal: SPACING.md,
  },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  modalTitle: { color: COLORS.text, fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  modalSub: { color: COLORS.textSecondary, fontSize: 13, lineHeight: 18, marginTop: 4, marginBottom: SPACING.lg },

  ppCard: {
    borderRadius: RADIUS.xl, overflow: 'hidden',
    backgroundColor: COLORS.background, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
  },
  ppBanner: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.lg,
    paddingHorizontal: SPACING.md, paddingTop: SPACING.md, paddingBottom: SPACING.lg,
    borderBottomLeftRadius: RADIUS.xl, borderBottomRightRadius: RADIUS.xl,
  },
  ppRingWrap: {
    width: 72, height: 72, alignItems: 'center', justifyContent: 'center',
    shadowOpacity: 0.5, shadowRadius: 12, shadowOffset: { width: 0, height: 0 }, elevation: 8,
  },
  ppRing: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  ppAvatarGap: { width: 66, height: 66, borderRadius: 33, backgroundColor: COLORS.background, alignItems: 'center', justifyContent: 'center' },
  ppAvatar: { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center' },
  ppAvatarText: { color: COLORS.text, fontSize: 24, fontWeight: '800' },
  ppEmblem: { position: 'absolute', bottom: -1, right: -1, backgroundColor: COLORS.background, borderRadius: RADIUS.full, padding: 2 },
  ppStats: {
    flex: 1, flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.22)', borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', paddingVertical: SPACING.sm,
  },
  ppStatItem: { flex: 1, alignItems: 'center', gap: 5 },
  ppStatBar: { width: 24, height: 12, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.22)' },
  ppStatLabel: { color: 'rgba(245,245,245,0.65)', fontSize: 10, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  ppInfo: { paddingHorizontal: SPACING.md, paddingTop: SPACING.sm, paddingBottom: SPACING.md, gap: 4 },
  ppNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  ppName: { color: COLORS.text, fontSize: 17, fontWeight: '800', letterSpacing: -0.2 },
  ppUsername: { color: COLORS.textMeta, fontSize: 13 },
  ppBio: { color: COLORS.textSecondary, fontSize: 14, lineHeight: 20, marginTop: 2 },
});
