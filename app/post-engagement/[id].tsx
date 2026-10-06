import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Animated, RefreshControl,
  LayoutChangeEvent, ActivityIndicator,
} from 'react-native';
import PagerView from 'react-native-pager-view';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { SPACING, RADIUS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import StoryAvatar from '../../components/StoryAvatar';
import BadgeEmblem from '../../components/BadgeEmblem';
import FollowButton from '../../components/FollowButton';
import { ListRowsSkeleton } from '../../components/Skeleton';
import { useStories } from '../../contexts/StoriesContext';
import { useTranslation } from '../../contexts/LanguageContext';
import {
  fetchPostEngagement, fetchLikers, fetchReposters,
  type EngagementUser, type PostEngagement,
} from '../../lib/postEngagement';

// Opened by tapping a post's like count. Anyone sees the likers; the post's own
// author additionally gets Reposts (by name) and Saved (count only — saves stay
// private). Owner tabs are SWIPEABLE (PagerView) and the lists PAGINATE past the
// first page. See lib/postEngagement.ts.

type Tab = 'likes' | 'reposts' | 'saved';
const OWNER_TABS: Tab[] = ['likes', 'reposts', 'saved'];
const PAGE_SIZE = 100;

export default function PostEngagementScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { refresh: refreshStories } = useStories();

  const [viewerId, setViewerId] = useState<string | null>(null);
  const [engagement, setEngagement] = useState<PostEngagement | null>(null);
  const [isOwn, setIsOwn] = useState(false);
  const [tab, setTab] = useState<Tab>('likes');

  // Per-tab paged lists (null = not loaded yet) + whether another page exists.
  const [likers, setLikers] = useState<EngagementUser[] | null>(null);
  const [likersMore, setLikersMore] = useState(true);
  const [reposters, setReposters] = useState<EngagementUser[] | null>(null);
  const [repostersMore, setRepostersMore] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Guards against firing a page load while one is already in flight (onEndReached
  // can fire repeatedly). Keyed by tab.
  const loadingRef = useRef<{ likes: boolean; reposts: boolean }>({ likes: false, reposts: false });

  const pagerRef = useRef<PagerView>(null);
  const [tabBarW, setTabBarW] = useState(0);
  // Continuous page position (0..2), driven by onPageScroll, for a smooth underline.
  const underX = useRef(new Animated.Value(0)).current;

  useFocusEffect(useCallback(() => { refreshStories(); }, [refreshStories]));

  // Resolve viewer + owner + authoritative counts, then load the first page of likers.
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const vid = user?.id ?? null;
      const eng = await fetchPostEngagement(id as string);
      if (!alive) return;
      setViewerId(vid);
      setEngagement(eng);
      setIsOwn(!!vid && eng.ownerId === vid);
      const first = await fetchLikers(id as string, vid, PAGE_SIZE, 0).catch(() => [] as EngagementUser[]);
      if (!alive) return;
      setLikers(first);
      setLikersMore(first.length === PAGE_SIZE);
    })();
    return () => { alive = false; };
  }, [id]);

  // Append the next page of a tab (or its first page when its list is still null).
  function loadMore(which: 'likes' | 'reposts') {
    if (!id) return;
    const cur = which === 'likes' ? likers : reposters;
    const more = which === 'likes' ? likersMore : repostersMore;
    if (loadingRef.current[which]) return;
    if (cur !== null && !more) return;
    loadingRef.current[which] = true;
    const offset = cur?.length ?? 0;
    const fn = which === 'likes' ? fetchLikers : fetchReposters;
    fn(id as string, viewerId, PAGE_SIZE, offset)
      .then((page) => {
        const hasMore = page.length === PAGE_SIZE;
        if (which === 'likes') { setLikers((prev) => [...(prev ?? []), ...page]); setLikersMore(hasMore); }
        else { setReposters((prev) => [...(prev ?? []), ...page]); setRepostersMore(hasMore); }
      })
      .catch(() => {
        if (which === 'likes') setLikers((prev) => prev ?? []);
        else setReposters((prev) => prev ?? []);
      })
      .finally(() => { loadingRef.current[which] = false; });
  }

  async function onRefresh() {
    if (!id) return;
    setRefreshing(true);
    const eng = await fetchPostEngagement(id as string).catch(() => null);
    if (eng) setEngagement(eng);
    if (tab === 'likes') {
      const first = await fetchLikers(id as string, viewerId, PAGE_SIZE, 0).catch(() => [] as EngagementUser[]);
      setLikers(first); setLikersMore(first.length === PAGE_SIZE);
    } else if (tab === 'reposts') {
      const first = await fetchReposters(id as string, viewerId, PAGE_SIZE, 0).catch(() => [] as EngagementUser[]);
      setReposters(first); setRepostersMore(first.length === PAGE_SIZE);
    }
    setRefreshing(false);
  }

  function selectTab(which: Tab) {
    pagerRef.current?.setPage(OWNER_TABS.indexOf(which));
  }

  function onPageSelected(e: { nativeEvent: { position: number } }) {
    const which = OWNER_TABS[e.nativeEvent.position] ?? 'likes';
    setTab(which);
    // Lazy-load reposters the first time the Reposts page is reached.
    if (which === 'reposts' && reposters === null) loadMore('reposts');
  }

  function onPageScroll(e: { nativeEvent: { position: number; offset: number } }) {
    underX.setValue(e.nativeEvent.position + e.nativeEvent.offset);
  }

  function onTabBarLayout(e: LayoutChangeEvent) {
    setTabBarW(e.nativeEvent.layout.width);
  }

  const tabWidth = tabBarW / OWNER_TABS.length;

  function renderRow({ item }: { item: EngagementUser }) {
    return (
      <View style={styles.userRow}>
        <TouchableOpacity style={styles.userLeft} onPress={() => router.push(`/profile/${item.id}`)}>
          <StoryAvatar userId={item.id} avatarUrl={item.avatar_url} name={item.display_name} size={46} />
          <View style={{ flex: 1 }}>
            <View style={styles.nameRow}>
              <Text style={styles.displayName} numberOfLines={1}>{item.display_name}</Text>
              <BadgeEmblem profile={item} size={13} />
            </View>
            {!!item.username && <Text style={styles.username} numberOfLines={1}>@{item.username}</Text>}
          </View>
        </TouchableOpacity>
        <FollowButton userId={item.id} />
      </View>
    );
  }

  function renderListPage(which: 'likes' | 'reposts') {
    const data = which === 'likes' ? likers : reposters;
    const more = which === 'likes' ? likersMore : repostersMore;
    if (data === null) {
      return <View style={styles.list}><ListRowsSkeleton rows={8} trailing /></View>;
    }
    return (
      <FlatList
        data={data}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        renderItem={renderRow}
        onEndReached={() => loadMore(which)}
        onEndReachedThreshold={0.4}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primaryLight} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name={which === 'reposts' ? 'repeat-outline' : 'heart-outline'} size={40} color={colors.textTertiary} />
            <Text style={styles.emptyText}>{which === 'reposts' ? t('postEngagement.repostsEmpty') : t('postEngagement.likesEmpty')}</Text>
          </View>
        }
        ListFooterComponent={more && data.length > 0 ? <ActivityIndicator style={{ paddingVertical: SPACING.md }} color={colors.textTertiary} /> : null}
      />
    );
  }

  function renderSavedPage() {
    return (
      <View style={styles.savedStat}>
        <View style={styles.savedIconWrap}>
          <Ionicons name="bookmark" size={30} color={colors.text} />
        </View>
        <Text style={styles.savedNumber}>{engagement?.saveCount ?? 0}</Text>
        <Text style={styles.savedLabel}>{t('postEngagement.savesLabel')}</Text>
        <Text style={styles.savedPrivate}>{t('postEngagement.savesPrivate')}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.headerTop}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.primaryLight} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{isOwn ? t('postEngagement.title') : t('postEngagement.likes')}</Text>
        <View style={{ width: 40 }} />
      </View>

      {isOwn ? (
        <>
          {/* Owner tab bar: Likes / Reposts / Saved — tap OR swipe below. */}
          <View style={styles.tabBar} onLayout={onTabBarLayout}>
            {OWNER_TABS.map((tk) => {
              const active = tk === tab;
              const count = tk === 'likes' ? engagement?.likeCount : tk === 'reposts' ? engagement?.repostCount : engagement?.saveCount;
              return (
                <TouchableOpacity key={tk} style={styles.tabItem} onPress={() => selectTab(tk)} activeOpacity={0.7}>
                  <Text style={[styles.tabCount, active && styles.tabCountActive]}>{count ?? 0}</Text>
                  <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{t(`postEngagement.${tk}` as any)}</Text>
                </TouchableOpacity>
              );
            })}
            {tabBarW > 0 && (
              <Animated.View
                style={[
                  styles.tabUnderline,
                  { width: tabWidth, transform: [{ translateX: Animated.multiply(underX, tabWidth) }] },
                ]}
              />
            )}
          </View>

          <PagerView
            ref={pagerRef}
            style={{ flex: 1 }}
            initialPage={0}
            onPageSelected={onPageSelected}
            onPageScroll={onPageScroll}
          >
            <View key="likes" style={{ flex: 1 }}>{renderListPage('likes')}</View>
            <View key="reposts" style={{ flex: 1 }}>{renderListPage('reposts')}</View>
            <View key="saved" style={{ flex: 1 }}>{renderSavedPage()}</View>
          </PagerView>
        </>
      ) : (
        // Non-owner: just the likers list (no tabs, no pager).
        renderListPage('likes')
      )}
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  headerTop: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },

  // Tab bar
  tabBar: {
    flexDirection: 'row', position: 'relative',
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  tabItem: { flex: 1, alignItems: 'center', paddingVertical: SPACING.sm + 2, gap: 1 },
  tabCount: { color: colors.textSecondary, fontSize: 16, fontWeight: '800' },
  tabCountActive: { color: colors.text },
  tabLabel: { color: colors.textTertiary, fontSize: 12, fontWeight: '600' },
  tabLabelActive: { color: colors.text },
  tabUnderline: { position: 'absolute', bottom: 0, left: 0, height: 2, backgroundColor: colors.text },

  // List rows (mirrors the followers/following list)
  list: { padding: SPACING.md, gap: SPACING.sm, flexGrow: 1 },
  userRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.md,
    padding: SPACING.md, borderWidth: 1, borderColor: colors.border,
  },
  userLeft: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, flex: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  displayName: { color: colors.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  username: { color: colors.textSecondary, fontSize: 12, marginTop: 1 },

  // Empty + saved-stat states
  empty: { alignItems: 'center', paddingTop: SPACING.xxl, gap: SPACING.md },
  emptyText: { color: colors.textTertiary, fontSize: 14 },
  savedStat: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SPACING.xl, gap: SPACING.sm },
  savedIconWrap: {
    width: 68, height: 68, borderRadius: 34, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border, marginBottom: SPACING.sm,
  },
  savedNumber: { color: colors.text, fontSize: 40, fontWeight: '900', letterSpacing: -0.5 },
  savedLabel: { color: colors.textSecondary, fontSize: 15, fontWeight: '700' },
  savedPrivate: { color: colors.textTertiary, fontSize: 13, textAlign: 'center', lineHeight: 18, marginTop: SPACING.xs, maxWidth: 280 },
});
