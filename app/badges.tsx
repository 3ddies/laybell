import {
  View, Text, StyleSheet, TouchableOpacity, Image, Modal,
  ScrollView, Switch, RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useProfile } from '../contexts/ProfileContext';
import BadgeEmblem from '../components/BadgeEmblem';
import SwipeBackPager from '../components/SwipeBackPager';
import {
  BADGES, CATEGORY_META, CATEGORY_ORDER, THEME_OPTIONS, THEME_RING_STYLE,
  isUnlocked, tierLabel, rawTier, badgeRingColors,
  evaluateBadges, fetchBadgeState, computeMetrics,
  type Tier, type BadgeState, type BadgeMetrics, type EvalResult, type BadgeDef, type BadgeCategory,
} from '../lib/badges';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { Skeleton, SkeletonCircle, SkeletonLine } from '../components/Skeleton';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

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
    case 'login_diamond_perm': return cur(m.loginStreak, 90, 'days');
    case 'daily_like_bronze': return cur(m.todayLikes, 10, 'today');
    case 'daily_like_silver': return cur(m.likeStreak, 3, 'days');
    case 'daily_like_gold':   return cur(m.likeStreak, 7, 'days');
    case 'posts_bronze': return cur(m.publicPosts, 1, 'public posts');
    case 'posts_silver': return cur(m.publicPosts, 5, 'public posts');
    case 'music_streaming_bronze': return cur(m.musicMinutesToday, 10, 'min today');
    case 'music_streaming_silver': return cur(m.musicMinutesToday, 20, 'min today');
    case 'music_streaming_gold':   return cur(m.musicMinutesToday, 30, 'min today');
    case 'comments_bronze': return cur(m.todayComments, 1, 'today');
    case 'comments_silver': return cur(m.todayComments, 2, 'today');
    case 'curator_bronze':  return cur(m.topPlaylistListens, 100, 'listens');
    case 'curator_silver':  return cur(m.topPlaylistListens, 500, 'listens');
    case 'curator_gold':    return cur(m.topPlaylistListens, 2500, 'listens');
    case 'ads_bronze': return cur(m.todayAdEngagements, 1, 'today');
    case 'ads_silver': return cur(m.todayAdEngagements, 2, 'today');
    case 'community_bronze': return cur(m.communitiesJoined, 1, 'joined');
    case 'community_silver': return cur(m.communitiesOwned, 1, 'owned');
    case 'app_sharing_bronze': return cur(m.appShares, 1, 'shares');
    case 'app_sharing_silver': return cur(m.appShares, 8, 'shares');
    case 'app_sharing_gold':   return cur(m.appShares, 15, 'shares');
    default: return { kind: 'progress', cur: 0, target: 1, unit: '' };
  }
}

export default function BadgesScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
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
  const previewBanner = previewTier ? [badgeRingColors(previewTier)[0], colors.background] : [colors.background, colors.background];
  // The avatar glow matches the previewed tier's ring color (falls back to the
  // brand color before any badge is earned).
  const previewGlow = previewTier ? badgeRingColors(previewTier)[0] : colors.primary;
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
    const accent = opt.minTier ? badgeRingColors(opt.minTier)[0] : colors.primary;
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
        {!unlocked && <Ionicons name="lock-closed" size={12} color={colors.textTertiary} />}
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
    // Swipe right anywhere to slide the whole page (header included) off and
    // reveal the screen underneath — one motion, same feel as the tab pager.
    <SwipeBackPager>
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('account.badges')}</Text>
        <View style={{ width: 40 }} />
      </View>

          {loading ? (
            <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
              {/* Hero card: centered avatar ring + corner emblem + title + meter */}
              <View style={[styles.hero, { alignItems: 'center' }]}>
                <View style={styles.previewWrap}>
                  <SkeletonCircle size={94} />
                  <View style={styles.previewEmblem}><SkeletonCircle size={24} /></View>
                </View>
                <SkeletonLine w={160} h={28} style={{ marginTop: 10 }} />
                <SkeletonLine w={130} h={12} style={{ marginTop: 10 }} />
                <Skeleton width="70%" height={6} radius={RADIUS.full} style={{ marginTop: SPACING.md }} />
              </View>

              {/* Customization — theme-chip card */}
              <SkeletonLine w={120} h={11} style={{ marginHorizontal: SPACING.xs, marginTop: SPACING.xs }} />
              <View style={styles.card}>
                <SkeletonLine w={150} h={22} style={{ marginBottom: SPACING.sm }} />
                <View style={styles.chipRows}>
                  <View style={styles.chipRow}>
                    {Array.from({ length: 3 }).map((_, i) => (
                      <Skeleton key={i} height={40} radius={RADIUS.full} style={{ flex: 1 }} />
                    ))}
                  </View>
                  <View style={styles.chipRow}>
                    <Skeleton height={40} radius={RADIUS.full} style={{ flex: 1 }} />
                  </View>
                  <View style={[styles.chipRow, { marginHorizontal: SPACING.lg }]}>
                    <Skeleton height={56} radius={24} style={{ flex: 1 }} />
                  </View>
                </View>
                <Skeleton height={44} radius={RADIUS.full} style={{ marginTop: SPACING.sm }} />
              </View>

              {/* All badges — category cards */}
              <SkeletonLine w={100} h={11} style={{ marginHorizontal: SPACING.xs, marginTop: SPACING.xs }} />
              {Array.from({ length: 3 }).map((_, ci) => (
                <View key={ci} style={styles.catCard}>
                  <View style={styles.catHead}>
                    <SkeletonCircle size={50} />
                    <SkeletonLine w={140} h={20} />
                  </View>
                  {Array.from({ length: 4 }).map((_, ri) => (
                    <View key={ri} style={styles.badgeRow}>
                      <SkeletonCircle size={24} />
                      <View style={{ flex: 1 }}>
                        <SkeletonLine w={90} h={12} />
                        <SkeletonLine w="80%" h={11} style={{ marginTop: 6 }} />
                      </View>
                      <View style={styles.badgeStatus}>
                        <SkeletonCircle size={26} />
                      </View>
                    </View>
                  ))}
                </View>
              ))}
            </ScrollView>
          ) : (
            <ScrollView
              contentContainerStyle={styles.scroll}
              showsVerticalScrollIndicator={false}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
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
                    <Text style={styles.heroTierWord}>{isPreviewing ? t('badges.preview') : t('badges.badge')}</Text>
                  </View>
                ) : (
                  <Text style={styles.heroTier}>{emblemTier ? t('badges.noBadgeShown') : t('badges.noBadgeYet')}</Text>
                )}
                <Text style={styles.heroSub}>
                  {emblemTier
                    ? `${points === 1 ? t('badges.pointOne', { points }) : t('badges.points', { points })}${next ? ` · ${t('badges.toNextTier', { n: next[1] - points, tier: tierLabel(next[0]) })}` : ` · ${t('badges.topTier')}`}`
                    : t('badges.earnToUnlock')}
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
              <Text style={styles.sectionTitle}>{t('badges.customization')}</Text>
              <Text style={styles.sectionHint}>{t('badges.customizationHint')}</Text>
              <View style={styles.card}>
                <Text style={styles.pickerLabel}>{t('account.badges')}</Text>
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
                  <Ionicons name="eye-outline" size={18} color={colors.text} />
                  <Text style={styles.previewPageBtnText}>{t('badges.previewPage')}</Text>
                </TouchableOpacity>
              </View>

              {/* Catalog grouped by category — most recently earned categories first. */}
              <Text style={styles.sectionTitle}>{t('badges.allBadges')}</Text>
              {orderedCats.map((cat) => (
                <CategoryCard key={cat} category={cat} metrics={metrics} held={held} t={t} />
              ))}

              <Text style={styles.footnote}>{t('badges.footnote')}</Text>

              {/* Show / hide emblem — moved to the bottom. */}
              <View style={styles.card}>
                <View style={styles.toggleRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.toggleLabel}>{t('badges.showEmblem')}</Text>
                    <Text style={styles.toggleSub}>{t('badges.showEmblemSub')}</Text>
                  </View>
                  <Switch
                    value={badgeShow}
                    onValueChange={(v) => persist({ badge_show: v })}
                    trackColor={{ false: colors.border, true: colors.primary + '88' }}
                    thumbColor={badgeShow ? colors.primary : colors.textTertiary}
                  />
                </View>
              </View>
            </ScrollView>
          )}

      {/* Page preview — the previewed theme (banner + ring + emblem) on a mock of
          the user's profile header, exactly as other people would see it. The
          Modal renders in its own native window, so living inside the swipe
          pager's page doesn't constrain it. */}
      <Modal visible={showPreview} animationType="slide" transparent onRequestClose={() => setShowPreview(false)}>
        <View style={styles.modalRoot}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{t('badges.pagePreview')}</Text>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.close')} onPress={() => setShowPreview(false)} hitSlop={10}>
              <Ionicons name="close" size={26} color={colors.text} />
            </TouchableOpacity>
          </View>
          <Text style={styles.modalSub}>
            {t('badges.pagePreviewSub', { theme: themeOpt?.label ?? 'Default' })}
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
                {[
                  { key: 'posts', label: t('profile.tab.posts') },
                  { key: 'followers', label: t('profile.followers') },
                  { key: 'following', label: t('profile.following') },
                ].map((s) => (
                  <View key={s.key} style={styles.ppStatItem}>
                    <View style={styles.ppStatBar} />
                    <Text style={styles.ppStatLabel}>{s.label}</Text>
                  </View>
                ))}
              </View>
            </LinearGradient>
            <View style={styles.ppInfo}>
              <View style={styles.ppNameRow}>
                <Text style={styles.ppName} numberOfLines={1}>{profile?.display_name ?? t('badges.yourName')}</Text>
                {badgeShow && previewTier && <BadgeEmblem tier={previewTier} size={17} />}
              </View>
              <Text style={styles.ppUsername} numberOfLines={1}>@{profile?.username ?? t('badges.username')}</Text>
              {!!profile?.bio && <Text style={styles.ppBio} numberOfLines={2}>{profile.bio}</Text>}
            </View>
          </View>
        </View>
      </Modal>
    </View>
    </SwipeBackPager>
  );
}

function CategoryCard({ category, metrics, held, t }: { category: BadgeCategory; metrics: BadgeMetrics | null; held: Set<string>; t: (key: string, vars?: Record<string, string | number>) => string }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
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
            <Ionicons name={meta.icon as any} size={24} color={colors.textTertiary} />
          </View>
        )}
        <Text style={styles.catTitle}>{t('badges.cat.' + category)}</Text>
      </View>
      {defs.map((def) => {
        const st = badgeStatus(def, metrics, held);
        return (
          <View key={def.key} style={styles.badgeRow}>
            <BadgeEmblem tier={def.tier} size={24} style={st.kind === 'earned' ? undefined : styles.dimmed} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.badgeTitle, st.kind !== 'earned' && styles.badgeTitleMuted]}>
                {tierLabel(def.tier)}
                {/* Permanent badges never revert once earned — flag them. */}
                {def.permanent && <Text style={styles.permanentTag}> {t('badges.permanentTag')}</Text>}
              </Text>
              <Text style={styles.badgeCriteria}>{t('badges.criteria.' + def.key)}</Text>
            </View>
            <View style={styles.badgeStatus}>
              {st.kind === 'earned' ? (
                <View style={styles.earnedCheck}>
                  <Ionicons name="checkmark-sharp" size={16} color="#fff" />
                </View>
              ) : st.kind === 'locked' ? (
                <Text style={styles.lockedText}>{t('badges.comingSoon')}</Text>
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
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '800', letterSpacing: -0.3 },

  scroll: { padding: SPACING.md, paddingBottom: SPACING.xxl + SPACING.lg, gap: SPACING.md },

  hero: {
    alignItems: 'center', gap: 6,
    borderRadius: RADIUS.xl, borderWidth: 1, borderColor: 'rgba(242,101,34,0.22)',
    paddingVertical: SPACING.lg + 2, paddingHorizontal: SPACING.md,
  },
  // Live preview avatar (story-ring look: gradient ring → gap → avatar).
  previewWrap: {
    width: 94, height: 94, alignItems: 'center', justifyContent: 'center', marginBottom: 2,
    shadowColor: colors.primary, shadowOpacity: 0.5, shadowRadius: 15, shadowOffset: { width: 0, height: 0 },
    elevation: 10,
  },
  previewRing: { width: 94, height: 94, borderRadius: 47, alignItems: 'center', justifyContent: 'center' },
  previewAvatarGap: {
    width: 86, height: 86, borderRadius: 43, backgroundColor: '#0B0603',
    alignItems: 'center', justifyContent: 'center',
  },
  previewAvatar: { width: 78, height: 78, borderRadius: 39, alignItems: 'center', justifyContent: 'center' },
  previewAvatarText: { color: colors.text, fontSize: 30, fontWeight: '800' },
  previewEmblem: {
    position: 'absolute', bottom: -1, right: -1,
    backgroundColor: '#0B0603', borderRadius: RADIUS.full, padding: 2,
  },
  heroTier: { color: colors.text, fontSize: 20, fontWeight: '800', marginTop: 8, letterSpacing: -0.3 },
  heroTitleWrap: { alignItems: 'center', marginTop: 8 },
  heroTierName: { color: colors.text, fontSize: 32, fontWeight: '900', letterSpacing: -0.6 },
  heroTierWord: { color: colors.textSecondary, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1.5, marginTop: 1 },
  heroSub: { color: colors.textSecondary, fontSize: 13, textAlign: 'center', lineHeight: 18 },
  heroBarTrack: {
    width: '70%', height: 6, borderRadius: RADIUS.full, marginTop: SPACING.sm,
    backgroundColor: 'rgba(255,255,255,0.10)', overflow: 'hidden',
  },
  heroBarFill: { height: '100%', borderRadius: RADIUS.full },

  card: {
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: colors.borderSubtle, padding: SPACING.md,
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  toggleLabel: { color: colors.text, fontSize: 15, fontWeight: '700' },
  toggleSub: { color: colors.textSecondary, fontSize: 12, marginTop: 2, lineHeight: 16 },

  sectionTitle: {
    color: colors.textTertiary, fontSize: 11, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.8, paddingHorizontal: SPACING.xs, marginTop: SPACING.xs,
  },
  sectionHint: { color: colors.textTertiary, fontSize: 12, lineHeight: 16, paddingHorizontal: SPACING.xs, marginTop: -SPACING.sm },
  pickerLabel: { color: colors.text, fontSize: 24, fontWeight: '900', letterSpacing: -0.4, marginBottom: SPACING.sm },
  chipRows: { gap: SPACING.sm },
  chipRow: { flexDirection: 'row', gap: SPACING.sm },
  chip: {
    flex: 1,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    backgroundColor: colors.surfaceElevated, borderRadius: RADIUS.full,
    borderWidth: 1, borderColor: colors.border,
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
  chipText: { color: colors.text, fontSize: 13.5, fontWeight: '600' },
  chipTextDiamond: {
    color: '#CFF6FF', fontSize: 18.5, fontWeight: '900',
    textTransform: 'uppercase', letterSpacing: 0.3,
  },
  themeDot: { width: 20, height: 20, borderRadius: 10, borderWidth: 1, borderColor: colors.border },
  innerDivider: { height: 0.5, backgroundColor: colors.borderSubtle, marginVertical: SPACING.md },

  catCard: {
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: colors.borderSubtle, padding: SPACING.md, gap: SPACING.sm,
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  catHead: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm + 2, marginBottom: SPACING.xs },
  catEmblemEmpty: {
    width: 50, height: 50, borderRadius: RADIUS.full,
    backgroundColor: colors.surfaceElevated, borderWidth: 1, borderColor: colors.borderSubtle,
    alignItems: 'center', justifyContent: 'center',
  },
  catTitle: { color: colors.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.3 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  // Fixed, centered status column so the checks / progress numbers line up
  // vertically across every row in a category.
  badgeStatus: { minWidth: 52, alignItems: 'center', justifyContent: 'center' },
  dimmed: { opacity: 0.6 },
  badgeTitle: { color: colors.text, fontSize: 13, fontWeight: '700' },
  badgeTitleMuted: { color: colors.textSecondary },
  permanentTag: { color: colors.textTertiary, fontSize: 11, fontWeight: '600' },
  badgeCriteria: { color: colors.textSecondary, fontSize: 13, lineHeight: 17, marginTop: 2 },
  // Earned badges show just a checkmark in a rounded green disc with a soft glow.
  earnedCheck: {
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: colors.success, alignItems: 'center', justifyContent: 'center',
    shadowColor: colors.success, shadowOpacity: 0.6, shadowRadius: 7, shadowOffset: { width: 0, height: 0 },
    elevation: 5,
  },
  lockedText: { color: colors.textTertiary, fontSize: 12, fontStyle: 'italic' },
  progressText: { color: colors.textSecondary, fontSize: 13, fontWeight: '700' },

  footnote: { color: colors.textTertiary, fontSize: 11, lineHeight: 16, paddingHorizontal: SPACING.xs, marginTop: SPACING.sm },

  previewPageBtn: {
    marginTop: SPACING.sm, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: SPACING.sm + 2, borderRadius: RADIUS.full,
    backgroundColor: colors.surfaceElevated, borderWidth: 1, borderColor: colors.border,
  },
  previewPageBtnText: { color: colors.text, fontSize: 14, fontWeight: '700', letterSpacing: 0.2 },

  // ── Page-preview modal ──
  modalRoot: {
    flex: 1, backgroundColor: colors.background,
    paddingTop: SPACING.xxl + SPACING.sm, paddingHorizontal: SPACING.md,
  },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  modalTitle: { color: colors.text, fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  modalSub: { color: colors.textSecondary, fontSize: 13, lineHeight: 18, marginTop: 4, marginBottom: SPACING.lg },

  ppCard: {
    borderRadius: RADIUS.xl, overflow: 'hidden',
    backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border,
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
  ppAvatarGap: { width: 66, height: 66, borderRadius: 33, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },
  ppAvatar: { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center' },
  ppAvatarText: { color: colors.text, fontSize: 24, fontWeight: '800' },
  ppEmblem: { position: 'absolute', bottom: -1, right: -1, backgroundColor: colors.background, borderRadius: RADIUS.full, padding: 2 },
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
  ppName: { color: colors.text, fontSize: 17, fontWeight: '800', letterSpacing: -0.2 },
  ppUsername: { color: colors.textMeta, fontSize: 13 },
  ppBio: { color: colors.textSecondary, fontSize: 14, lineHeight: 20, marginTop: 2 },
});
