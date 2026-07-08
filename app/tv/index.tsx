import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, FlatList, Image, RefreshControl, Dimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import SwipeBackPager from '../../components/SwipeBackPager';
import TVVideoList from '../../components/TVVideoList';
import { Skeleton, SkeletonLine, ListRowsSkeleton } from '../../components/Skeleton';
import { GRADIENTS, RADIUS, SPACING, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { useProfile } from '../../contexts/ProfileContext';
import { fetchHorizontalVideos, matchesQuery, rankVideosForUser } from '../../lib/tv';
import { fetchLiveStreams, type LiveStream } from '../../lib/live';

// Laybell TV — a horizontal-only video hub. It adds NO new media types: the
// Videos tab is the existing reel-explore grid filtered to landscape videos,
// and the Lives tab lists live broadcasts flagged horizontal. Both hand off to
// the already-built viewers (/reel/[id], /live).

type Tab = 'videos' | 'lives';

// Loading-skeleton geometry — mirrors TVVideoList (a portrait Recommended row +
// a 2-up landscape grid).
const TV_SW = Dimensions.get('window').width;
const TV_GAP = SPACING.sm;
const TV_COL_W = (TV_SW - SPACING.md * 2 - TV_GAP) / 2;
const TV_COL_THUMB_H = TV_COL_W * (9 / 16);
const TV_FEAT_W = Math.round((TV_SW - SPACING.md * 2) * 0.42);
const TV_FEAT_H = Math.round(TV_FEAT_W * 1.3);

export default function LaybellTVScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { profile } = useProfile();

  const [tab, setTab] = useState<Tab>('videos');
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');

  const [videos, setVideos] = useState<any[]>([]);
  // `ranked` = videos in personalized relevance order (drives the Recommended row
  // + the grid order); `videos` stays newest-first for search.
  const [ranked, setRanked] = useState<any[]>([]);
  const [lives, setLives] = useState<LiveStream[]>([]);
  const [loadingVideos, setLoadingVideos] = useState(true);
  const [loadingLives, setLoadingLives] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadVideos = useCallback(async () => {
    try {
      const vids = await fetchHorizontalVideos();
      setVideos(vids);
      setRanked(await rankVideosForUser(vids, profile?.id ?? null));
    } catch { /* pre-migration / offline */ }
    setLoadingVideos(false);
  }, [profile?.id]);
  const loadLives = useCallback(async () => {
    try { setLives(await fetchLiveStreams(true)); } catch { /* offline */ }
    setLoadingLives(false);
  }, []);

  useEffect(() => { loadVideos(); loadLives(); }, [loadVideos, loadLives]);

  // Searching flattens to a single 2-up grid of matches. Otherwise the top 4
  // personalized picks become the Recommended row and the rest fill the grid.
  const searching = query.trim().length > 0;
  const featured = searching ? [] : ranked.slice(0, 4);
  const featuredIds = new Set(featured.map((v) => v.id));
  const gridVideos = searching
    ? videos.filter((v) => matchesQuery(v, query))
    : ranked.filter((v) => !featuredIds.has(v.id));

  return (
    <SwipeBackPager>
      <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <View style={styles.titleWrap}>
            <Ionicons name="tv" size={18} color={colors.primary} />
            <Text style={styles.headerTitle}>{t('tv.title')}</Text>
          </View>
          <TouchableOpacity onPress={() => router.push('/live/go-live')} style={styles.headerBtn}>
            <Ionicons name="radio-outline" size={20} color={colors.text} />
          </TouchableOpacity>
        </View>

        {/* Segmented tabs + search circle */}
        <View style={styles.tabRow}>
          <View style={styles.segment}>
            {(['videos', 'lives'] as Tab[]).map((k) => (
              <TouchableOpacity
                key={k}
                style={[styles.segmentBtn, tab === k && styles.segmentBtnActive]}
                onPress={() => setTab(k)}
              >
                <Text style={[styles.segmentText, tab === k && styles.segmentTextActive]}>{t(`tv.tab.${k}`)}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TouchableOpacity
            style={[styles.searchCircle, searchOpen && styles.searchCircleActive]}
            onPress={() => { setSearchOpen((v) => !v); if (searchOpen) setQuery(''); }}
          >
            <Ionicons name={searchOpen ? 'close' : 'search'} size={18} color={searchOpen ? colors.primary : colors.text} />
          </TouchableOpacity>
        </View>

        {searchOpen && (
          <View style={styles.searchBar}>
            <Ionicons name="search" size={16} color={colors.textTertiary} />
            <TextInput
              style={styles.searchInput}
              placeholder={t('tv.searchPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              value={query}
              onChangeText={setQuery}
              autoFocus
              returnKeyType="search"
            />
          </View>
        )}

        {tab === 'videos' ? (
          loadingVideos ? (
            <View style={styles.videoSkeleton}>
              <SkeletonLine w="55%" h={15} />
              <View style={styles.videoSkeletonFeat}>
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} width={TV_FEAT_W} height={TV_FEAT_H} radius={RADIUS.md} />
                ))}
              </View>
              <SkeletonLine w="40%" h={15} style={{ marginTop: SPACING.sm }} />
              <View style={styles.videoSkeletonGrid}>
                {Array.from({ length: 4 }).map((_, i) => (
                  <View key={i} style={styles.videoSkeletonCard}>
                    <Skeleton width={TV_COL_W} height={TV_COL_THUMB_H} radius={RADIUS.md} />
                    <SkeletonLine w="80%" h={11} />
                    <SkeletonLine w="45%" h={10} />
                  </View>
                ))}
              </View>
            </View>
          ) : (
            <TVVideoList
              posts={gridVideos}
              featured={featured}
              currentUserId={profile?.id ?? null}
              refreshing={refreshing}
              onRefresh={async () => { setRefreshing(true); await loadVideos(); setRefreshing(false); }}
              bottomPad={insets.bottom + 24}
              emptyText={query.trim() ? t('tv.noResults') : t('tv.noVideos')}
              onPostDeleted={(id) => {
                setVideos((prev) => prev.filter((p) => p.id !== id));
                setRanked((prev) => prev.filter((p) => p.id !== id));
              }}
            />
          )
        ) : loadingLives ? (
          <ListRowsSkeleton rows={5} />
        ) : (
          <FlatList
            data={lives}
            keyExtractor={(l) => l.id}
            contentContainerStyle={styles.livesContent}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                tintColor={colors.textSecondary}
                onRefresh={async () => { setRefreshing(true); await loadLives(); setRefreshing(false); }}
              />
            }
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.liveCard} onPress={() => router.push({ pathname: '/live', params: { streamId: item.id } })} activeOpacity={0.85}>
                {item.profile?.avatar_url ? (
                  <Image source={{ uri: item.profile.avatar_url }} style={styles.liveAvatar} />
                ) : (
                  <LinearGradient colors={GRADIENTS.primary} style={styles.liveAvatar}>
                    <Text style={styles.liveInitial}>
                      {(item.profile?.display_name || item.profile?.username || '?').charAt(0).toUpperCase()}
                    </Text>
                  </LinearGradient>
                )}
                <View style={styles.liveInfo}>
                  <Text style={styles.liveTitle} numberOfLines={1}>
                    {item.title || item.profile?.display_name || item.profile?.username || t('tv.liveUntitled')}
                  </Text>
                  <Text style={styles.liveHost} numberOfLines={1}>
                    {item.profile?.display_name || item.profile?.username || ''}
                  </Text>
                </View>
                <View style={styles.livePill}><Text style={styles.livePillText}>{t('live.live')}</Text></View>
              </TouchableOpacity>
            )}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Ionicons name="tv-outline" size={40} color={colors.textTertiary} />
                <Text style={styles.emptyText}>{t('tv.noLives')}</Text>
              </View>
            }
          />
        )}
      </View>
    </SwipeBackPager>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  titleWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  headerTitle: { color: c.text, fontSize: 17, fontWeight: '800', letterSpacing: -0.2 },
  tabRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: SPACING.md, marginTop: 4, marginBottom: 10 },
  segment: { flex: 1, flexDirection: 'row', backgroundColor: c.surfaceLight, borderRadius: RADIUS.full, padding: 3 },
  segmentBtn: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: RADIUS.full },
  segmentBtnActive: { backgroundColor: c.surfaceElevated },
  segmentText: { color: c.textTertiary, fontSize: 13, fontWeight: '600' },
  segmentTextActive: { color: c.text },
  searchCircle: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: c.surfaceLight,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.border,
  },
  searchCircleActive: { borderColor: c.primary },
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: SPACING.md, marginBottom: 10,
    backgroundColor: c.surfaceLight, borderRadius: RADIUS.md, paddingHorizontal: 12,
  },
  searchInput: { flex: 1, color: c.text, fontSize: 14, paddingVertical: 10 },
  videoSkeleton: { paddingHorizontal: SPACING.md, paddingTop: 2, gap: SPACING.sm },
  videoSkeletonFeat: { flexDirection: 'row', gap: TV_GAP },
  videoSkeletonGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: TV_GAP },
  videoSkeletonCard: { width: TV_COL_W, gap: 6 },
  livesContent: { paddingHorizontal: SPACING.md, gap: 10, paddingBottom: 40 },
  liveCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: c.surface, borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, padding: 10,
  },
  liveAvatar: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  liveInitial: { color: '#fff', fontSize: 18, fontWeight: '700' },
  liveInfo: { flex: 1, gap: 2 },
  liveTitle: { color: c.text, fontSize: 14, fontWeight: '700' },
  liveHost: { color: c.textTertiary, fontSize: 12 },
  livePill: { backgroundColor: '#F43F5E', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  livePillText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.8 },
  empty: { alignItems: 'center', gap: 10, marginTop: 40 },
  emptyText: { color: c.textTertiary, fontSize: 13, textAlign: 'center', paddingHorizontal: 30 },
});
