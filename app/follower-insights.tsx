import { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import SwipeBackPager from '../components/SwipeBackPager';
import StoryAvatar from '../components/StoryAvatar';
import BadgeEmblem from '../components/BadgeEmblem';
import FollowButton from '../components/FollowButton';
import { ListRowsSkeleton } from '../components/Skeleton';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { usePremium } from '../contexts/PremiumContext';
import { fetchNotFollowingBack, fetchRecentUnfollowers, type InsightUser } from '../lib/followerInsights';
import { timeAgo } from '../lib/timeAgo';

// Premium "Follower insights": two lists — people who don't follow you back, and
// people who unfollowed you. Gated behind Premium (the perk); non-subscribers see
// an upsell that routes to /premium.

type Tab = 'notBack' | 'unfollowed';

export default function FollowerInsightsScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const router = useRouter();
  const { isPremium } = usePremium();

  const [tab, setTab] = useState<Tab>('notBack');
  const [notBack, setNotBack] = useState<InsightUser[]>([]);
  const [unfollowed, setUnfollowed] = useState<InsightUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!isPremium) { setLoading(false); return; }
    const [a, b] = await Promise.all([fetchNotFollowingBack(), fetchRecentUnfollowers()]);
    setNotBack(a);
    setUnfollowed(b);
    setLoading(false);
  }, [isPremium]);

  useEffect(() => { load(); }, [load]);

  const data = tab === 'notBack' ? notBack : unfollowed;

  const Header = (
    <View style={styles.header}>
      <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
        <Ionicons name="chevron-back" size={24} color={colors.text} />
      </TouchableOpacity>
      <Text style={styles.headerTitle}>{t('followerInsights.title')}</Text>
      <View style={{ width: 40 }} />
    </View>
  );

  // Premium gate — the whole feature is a Premium perk.
  if (!isPremium) {
    return (
      <SwipeBackPager>
        <View style={styles.container}>
          {Header}
          <View style={styles.lockWrap}>
            <LinearGradient colors={GRADIENTS.primary as any} style={styles.lockIcon} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
              <Ionicons name="people" size={30} color="#fff" />
            </LinearGradient>
            <Text style={styles.lockTitle}>{t('followerInsights.lockTitle')}</Text>
            <Text style={styles.lockBody}>{t('followerInsights.lockBody')}</Text>
            <TouchableOpacity style={styles.upgradeBtn} onPress={() => router.push('/premium')} activeOpacity={0.85}>
              <LinearGradient colors={GRADIENTS.primary as any} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.upgradeInner}>
                <Ionicons name="star" size={16} color="#fff" />
                <Text style={styles.upgradeText}>{t('followerInsights.upgrade')}</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </View>
      </SwipeBackPager>
    );
  }

  return (
    <SwipeBackPager>
      <View style={styles.container}>
        {Header}

        <View style={styles.segment}>
          {(['notBack', 'unfollowed'] as Tab[]).map((k) => (
            <TouchableOpacity key={k} style={[styles.segmentBtn, tab === k && styles.segmentBtnActive]} onPress={() => setTab(k)}>
              <Text style={[styles.segmentText, tab === k && styles.segmentTextActive]}>
                {t(`followerInsights.tab.${k}`)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {loading ? (
          <View style={styles.list}><ListRowsSkeleton rows={8} trailing /></View>
        ) : (
          <FlatList
            data={data}
            keyExtractor={(u) => u.id}
            contentContainerStyle={styles.list}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                tintColor={colors.textSecondary}
                onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
              />
            }
            ListEmptyComponent={
              <View style={styles.empty}>
                <Ionicons name={tab === 'notBack' ? 'checkmark-circle-outline' : 'heart-outline'} size={40} color={colors.textTertiary} />
                <Text style={styles.emptyText}>{t(tab === 'notBack' ? 'followerInsights.emptyNotBack' : 'followerInsights.emptyUnfollowed')}</Text>
              </View>
            }
            renderItem={({ item }) => (
              <View style={styles.userRow}>
                <TouchableOpacity style={styles.userLeft} onPress={() => router.push(`/profile/${item.id}`)}>
                  <StoryAvatar userId={item.id} avatarUrl={item.avatar_url} name={item.display_name ?? ''} size={46} />
                  <View style={{ flex: 1 }}>
                    <View style={styles.nameRow}>
                      <Text style={styles.displayName} numberOfLines={1}>{item.display_name}</Text>
                      <BadgeEmblem profile={item} size={13} />
                    </View>
                    {!!item.username && <Text style={styles.username} numberOfLines={1}>@{item.username}</Text>}
                    {tab === 'unfollowed' && !!item.unfollowed_at && (
                      <Text style={styles.meta}>{t('followerInsights.unfollowedAt', { when: timeAgo(item.unfollowed_at) })}</Text>
                    )}
                  </View>
                </TouchableOpacity>
                <FollowButton userId={item.id} />
              </View>
            )}
          />
        )}
      </View>
    </SwipeBackPager>
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

  segment: {
    flexDirection: 'row', backgroundColor: colors.surfaceLight, borderRadius: RADIUS.full,
    padding: 3, margin: SPACING.md, marginBottom: SPACING.sm,
  },
  segmentBtn: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: RADIUS.full },
  segmentBtnActive: { backgroundColor: colors.surfaceElevated },
  segmentText: { color: colors.textTertiary, fontSize: 13, fontWeight: '700' },
  segmentTextActive: { color: colors.text },

  list: { paddingHorizontal: SPACING.md, gap: SPACING.sm, paddingBottom: SPACING.xxl, flexGrow: 1 },
  userRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.md,
    padding: SPACING.md, borderWidth: 1, borderColor: colors.border, gap: SPACING.sm,
  },
  userLeft: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, flex: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  displayName: { color: colors.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  username: { color: colors.textSecondary, fontSize: 12, marginTop: 1 },
  meta: { color: colors.textTertiary, fontSize: 11, marginTop: 2 },

  empty: { alignItems: 'center', paddingTop: SPACING.xxl, gap: SPACING.md },
  emptyText: { color: colors.textTertiary, fontSize: 14, textAlign: 'center', paddingHorizontal: 30 },

  lockWrap: { alignItems: 'center', justifyContent: 'center', flex: 1, gap: SPACING.md, padding: SPACING.xl },
  lockIcon: { width: 66, height: 66, borderRadius: 33, alignItems: 'center', justifyContent: 'center' },
  lockTitle: { color: colors.text, fontSize: 18, fontWeight: '800', textAlign: 'center' },
  lockBody: { color: colors.textSecondary, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  upgradeBtn: { borderRadius: RADIUS.full, overflow: 'hidden', marginTop: SPACING.sm, alignSelf: 'stretch' },
  upgradeInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: SPACING.md },
  upgradeText: { color: '#fff', fontSize: 15, fontWeight: '800' },
});
