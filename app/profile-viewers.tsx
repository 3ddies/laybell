import { View, Text, StyleSheet, FlatList, TouchableOpacity, Switch, RefreshControl, ActivityIndicator, Animated, Easing } from 'react-native';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { useProfile } from '../contexts/ProfileContext';
import { useStories } from '../contexts/StoriesContext';
import StoryAvatar from '../components/StoryAvatar';
import BadgeEmblem from '../components/BadgeEmblem';
import FollowButton from '../components/FollowButton';
import { ListRowsSkeleton } from '../components/Skeleton';
import { timeAgo } from '../lib/timeAgo';
import { fetchProfileViewers, setProfileViewsEnabled, type ProfileViewer } from '../lib/profileViews';

// "Viewed your profile" (profile_views.sql) — TikTok-style: one reciprocity toggle
// (see your viewers AND appear in theirs), a 30-day window, newest first.
export default function ProfileViewersScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { profile, refresh } = useProfile();
  const { refresh: refreshStories } = useStories();

  const enabled = !!profile?.profile_views_enabled;
  const [viewers, setViewers] = useState<ProfileViewer[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [toggling, setToggling] = useState(false);

  const load = useCallback(async () => {
    if (!enabled) { setViewers([]); setLoading(false); return; }
    const v = await fetchProfileViewers(200);
    setViewers(v);
    setLoading(false);
  }, [enabled]);

  useEffect(() => { setLoading(true); load(); }, [load]);
  useFocusEffect(useCallback(() => { refreshStories(); }, [refreshStories]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const onToggle = useCallback(async (on: boolean) => {
    setToggling(true);
    const ok = await setProfileViewsEnabled(on);
    if (ok) await refresh(); // reloads profile.profile_views_enabled → load() re-runs
    setToggling(false);
  }, [refresh]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.primaryLight} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('profileViews.title')}</Text>
        <View style={{ width: 40 }} />
      </View>

      {!enabled ? (
        // Not opted in: a focused, inviting empty state with one clear action.
        <ViewsEmpty
          icon="eye-off-outline"
          title={t('profileViews.gateTitle')}
          subtitle={t('profileViews.gateSub')}
          cta={
            <TouchableOpacity style={styles.ctaBtn} onPress={() => onToggle(true)} disabled={toggling} activeOpacity={0.9}>
              <LinearGradient colors={GRADIENTS.primary} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.ctaFill}>
                {toggling ? <ActivityIndicator color="#fff" /> : <Text style={styles.ctaText}>{t('profileViews.enableCta')}</Text>}
              </LinearGradient>
            </TouchableOpacity>
          }
        />
      ) : (
        <>
          <View style={styles.toggleRow}>
            <View style={styles.toggleTextWrap}>
              <Text style={styles.toggleTitle}>{t('profileViews.toggleTitle')}</Text>
              <Text style={styles.toggleSub}>{t('profileViews.toggleSub')}</Text>
            </View>
            <Switch
              value={enabled}
              onValueChange={onToggle}
              disabled={toggling}
              // Black in light mode, white in dark — colors.text — instead of orange;
              // the thumb takes the background so it stays legible on either track.
              trackColor={{ true: colors.text, false: colors.border }}
              thumbColor={colors.background}
              ios_backgroundColor={colors.border}
            />
          </View>

          {loading ? (
            <View style={styles.list}><ListRowsSkeleton rows={8} trailing /></View>
          ) : (
            <FlatList
              data={viewers}
              keyExtractor={(item) => item.viewer_id}
              contentContainerStyle={styles.list}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primaryLight} />}
              ListHeaderComponent={viewers.length ? <Text style={styles.windowNote}>{t('profileViews.window')}</Text> : null}
              ListEmptyComponent={
                <ViewsEmpty bare icon="eye-outline" title={t('profileViews.emptyTitle')} subtitle={t('profileViews.emptySub')} />
              }
              renderItem={({ item }) => (
                <View style={styles.userRow}>
                  <TouchableOpacity style={styles.userLeft} onPress={() => router.push(`/profile/${item.viewer_id}`)}>
                    <StoryAvatar userId={item.viewer_id} avatarUrl={item.avatar_url} name={item.display_name} size={46} />
                    <View style={styles.nameCol}>
                      <View style={styles.nameRow}>
                        <Text style={styles.displayName} numberOfLines={1}>{item.display_name || item.username || ''}</Text>
                        <BadgeEmblem profile={{ badge_tier: item.badge_tier, badge_show: item.badge_show }} size={13} />
                      </View>
                      <Text style={styles.sub} numberOfLines={1}>
                        {item.username ? `@${item.username} · ` : ''}{timeAgo(item.viewed_at)}
                      </Text>
                    </View>
                  </TouchableOpacity>
                  <FollowButton userId={item.viewer_id} />
                </View>
              )}
            />
          )}
        </>
      )}
    </View>
  );
}

// A polished, iOS-style empty state: a soft dimensional icon circle that gently
// breathes (so the page never reads as static), a bold title, a supporting line,
// and an optional call-to-action. Eased entrance on mount.
function ViewsEmpty({ icon, title, subtitle, cta, bare }: {
  icon: keyof typeof Ionicons.glyphMap; title: string; subtitle: string; cta?: ReactNode;
  // bare = a big glyph with NO circle behind it (the toggled-ON empty state); the
  // gate keeps the soft circle.
  bare?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const enter = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.timing(enter, { toValue: 1, duration: 440, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1.06, duration: 1800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1, duration: 1800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [enter, pulse]);

  const entrance = {
    opacity: enter,
    transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
  };

  return (
    <Animated.View style={[styles.emptyWrap, entrance]}>
      <Animated.View style={[bare ? styles.emptyBare : styles.emptyGlow, { transform: [{ scale: pulse }] }]}>
        {bare ? (
          <Ionicons name={icon} size={80} color={colors.textSecondary} />
        ) : (
          <LinearGradient colors={[colors.surfaceElevated, colors.surfaceLight]} style={styles.emptyCircle}>
            <Ionicons name={icon} size={42} color={colors.textSecondary} />
          </LinearGradient>
        )}
      </Animated.View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptySubtitle}>{subtitle}</Text>
      {cta ? <View style={styles.ctaWrap}>{cta}</View> : null}
    </Animated.View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },

  toggleRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  toggleTextWrap: { flex: 1 },
  toggleTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  toggleSub: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },

  // Empty / gate state. The bottom padding biases the centered block UPWARD so it
  // reads as centered on the screen rather than sinking below the header.
  emptyWrap: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SPACING.xl, paddingBottom: SPACING.xxl * 2, gap: SPACING.sm },
  emptyBare: { marginBottom: SPACING.xs },
  emptyGlow: {
    // A soft lift under the circle so it sits ON the page rather than in it.
    shadowColor: colors.primary, shadowOpacity: 0.14, shadowRadius: 20, shadowOffset: { width: 0, height: 8 },
    elevation: 4, borderRadius: 999, marginBottom: SPACING.xs,
  },
  emptyCircle: {
    width: 104, height: 104, borderRadius: 52, alignItems: 'center', justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  emptyTitle: { color: colors.text, fontSize: 21, fontWeight: '800', textAlign: 'center', letterSpacing: 0.2 },
  emptySubtitle: { color: colors.textSecondary, fontSize: 14, textAlign: 'center', lineHeight: 20, maxWidth: 300 },
  ctaWrap: { marginTop: SPACING.md },
  ctaBtn: { borderRadius: RADIUS.full, overflow: 'hidden' },
  ctaFill: { paddingVertical: SPACING.sm + 4, paddingHorizontal: SPACING.xl, alignItems: 'center', justifyContent: 'center', minWidth: 200 },
  ctaText: { color: '#fff', fontSize: 15, fontWeight: '800' },

  list: { padding: SPACING.md, gap: SPACING.sm, flexGrow: 1 },
  windowNote: { color: colors.textTertiary, fontSize: 12, marginBottom: SPACING.sm },
  userRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.md,
    padding: SPACING.md, borderWidth: 1, borderColor: colors.border,
  },
  userLeft: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, flex: 1 },
  nameCol: { flex: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  displayName: { color: colors.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  sub: { color: colors.textSecondary, fontSize: 12, marginTop: 1 },
});
