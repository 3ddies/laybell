import { View, Text, StyleSheet, TouchableOpacity, FlatList, ScrollView, Dimensions, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { usePostOptions } from '../contexts/PostOptionsContext';
import { isSwipeTap } from '../contexts/PagerContext';
import VideoThumb from './VideoThumb';
import ThumbStat from './ThumbStat';

// Laybell TV — Videos tab. Two shapes on one screen:
//   • Recommended row (top 4) — PORTRAIT reel-style tiles (the pre-redesign look),
//     a horizontal carousel; these are the user's personalized picks (lib/tv
//     rankVideosForUser). Center-cropped like the reel grid.
//   • Everything else — LANDSCAPE 16:9 cards, 2 per row, with the caption + author
//     below (TV-listing / YouTube-style).
// Both open the existing reel viewer (/reel/[id], seeded so it expands instantly);
// long-press opens the shared post options.

type TVPost = {
  id: string; type: string; media_url: string; caption?: string | null;
  thumbnail_url?: string | null; aspect_ratio?: string | null;
  view_count?: number; stream_count?: number; user_id?: string;
  profiles?: { username?: string | null; display_name?: string | null } | null;
};

const H_PADDING = SPACING.md;
const GRID_GAP = SPACING.sm;
const SCREEN_W = Dimensions.get('window').width;
// 2-up landscape grid cell.
const COL_W = (SCREEN_W - H_PADDING * 2 - GRID_GAP) / 2;
const COL_THUMB_H = COL_W * (9 / 16);
// Portrait "recommended" tile (mirrors the old reel-grid tile proportions).
const FEAT_W = Math.round((SCREEN_W - H_PADDING * 2) * 0.42);
const FEAT_H = Math.round(FEAT_W * 1.3);

export default function TVVideoList({ posts, featured, currentUserId, refreshing, onRefresh, bottomPad, emptyText, onPostDeleted, castActive, onCast }: {
  posts: TVPost[];
  // Personalized top picks shown as portrait tiles above the grid (omit/empty to
  // hide the row — e.g. while searching).
  featured?: TVPost[];
  currentUserId?: string | null;
  refreshing?: boolean;
  onRefresh?: () => void;
  bottomPad?: number;
  emptyText?: string;
  onPostDeleted?: (id: string) => void;
  // When a Cast session is live, tapping a tile throws it to the TV (via onCast)
  // instead of opening the on-phone reel viewer.
  castActive?: boolean;
  onCast?: (post: TVPost) => void;
}) {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { show: showOptions } = usePostOptions();

  const openVideo = (p: TVPost, e?: any, w = COL_W, h = COL_THUMB_H) => {
    if (isSwipeTap()) return; // a tab swipe gliding over a card must not open the viewer
    // Casting to a TV: hand the tile off to the TV instead of the phone viewer.
    if (castActive && onCast) { onCast(p); return; }
    const ne = e?.nativeEvent;
    const src = ne
      ? JSON.stringify({ x: ne.pageX - ne.locationX, y: ne.pageY - ne.locationY, width: w, height: h })
      : undefined;
    router.push({ pathname: '/reel/[id]', params: { id: p.id, post: JSON.stringify(p), ...(src ? { src } : {}) } });
  };

  const longPressFor = (p: TVPost) =>
    currentUserId
      ? () => showOptions({
          postId: p.id,
          isOwn: p.user_id === currentUserId,
          authorId: p.user_id,
          authorName: p.profiles?.username ?? undefined,
          mediaType: p.type,
          onEdit: () => router.push(`/edit-post/${p.id}`),
          onDeleted: () => onPostDeleted?.(p.id),
          onArchived: () => onPostDeleted?.(p.id),
          onBlocked: () => onPostDeleted?.(p.id),
        })
      : undefined;

  const feat = featured ?? [];
  const header = feat.length > 0 ? (
    <View style={styles.featSection}>
      <Text style={styles.featTitle}>{t('tv.recommended')}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.featRow}
      >
        {feat.map((p) => (
          <TouchableOpacity
            key={p.id}
            style={styles.featTile}
            activeOpacity={0.9}
            onPress={(e: any) => openVideo(p, e, FEAT_W, FEAT_H)}
            onLongPress={longPressFor(p)}
          >
            <VideoThumb thumbnailUrl={p.thumbnail_url} mediaUrl={p.media_url} style={styles.featThumb} />
            <View style={styles.playBadge}><Ionicons name="play" size={12} color="#fff" /></View>
            <LinearGradient colors={['transparent', 'rgba(0,0,0,0.78)']} style={styles.featOverlay}>
              {!!p.profiles?.username && <Text style={styles.featUser} numberOfLines={1}>@{p.profiles.username}</Text>}
            </LinearGradient>
            <ThumbStat type={p.type} viewCount={p.view_count} streamCount={p.stream_count} />
          </TouchableOpacity>
        ))}
      </ScrollView>
      {posts.length > 0 && <Text style={styles.gridTitle}>{t('tv.moreVideos')}</Text>}
    </View>
  ) : null;

  return (
    <FlatList
      data={posts}
      keyExtractor={(p) => p.id}
      numColumns={2}
      columnWrapperStyle={styles.rowWrap}
      contentContainerStyle={[styles.content, { paddingBottom: (bottomPad ?? 0) + SPACING.xxl }]}
      showsVerticalScrollIndicator={false}
      ListHeaderComponent={header}
      refreshControl={
        onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} /> : undefined
      }
      renderItem={({ item: p }) => {
        const title = p.caption?.trim() || p.profiles?.display_name || (p.profiles?.username ? `@${p.profiles.username}` : t('tv.title'));
        return (
          <TouchableOpacity
            style={styles.card}
            activeOpacity={0.9}
            onPress={(e: any) => openVideo(p, e)}
            onLongPress={longPressFor(p)}
          >
            <View style={styles.thumbWrap}>
              <VideoThumb thumbnailUrl={p.thumbnail_url} mediaUrl={p.media_url} style={styles.thumb} />
              <View style={styles.playBadge}><Ionicons name="play" size={12} color="#fff" /></View>
              <ThumbStat type={p.type} viewCount={p.view_count} streamCount={p.stream_count} />
            </View>
            <Text style={styles.caption} numberOfLines={2}>{title}</Text>
            {!!p.profiles?.username && <Text style={styles.author} numberOfLines={1}>@{p.profiles.username}</Text>}
          </TouchableOpacity>
        );
      }}
      ListEmptyComponent={
        <View style={styles.empty}>
          <Ionicons name="tv-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyText}>{emptyText ?? t('tv.noVideos')}</Text>
        </View>
      }
    />
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  content: { paddingHorizontal: H_PADDING, paddingTop: 2 },
  rowWrap: { gap: GRID_GAP, marginBottom: SPACING.lg },

  // Recommended (portrait) carousel
  featSection: { marginBottom: SPACING.sm },
  featTitle: { color: c.text, fontSize: 15, fontWeight: '800', marginBottom: SPACING.sm },
  featRow: { gap: GRID_GAP, paddingRight: H_PADDING },
  featTile: {
    width: FEAT_W, height: FEAT_H, borderRadius: RADIUS.md, overflow: 'hidden',
    backgroundColor: c.surfaceLight,
  },
  featThumb: { width: '100%', height: '100%' },
  featOverlay: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.lg, paddingBottom: 6,
  },
  featUser: { color: '#fff', fontSize: 11, fontWeight: '600' },
  gridTitle: { color: c.text, fontSize: 15, fontWeight: '800', marginTop: SPACING.md },

  // Landscape 2-up grid
  card: { width: COL_W },
  thumbWrap: {
    width: COL_W, height: COL_THUMB_H, borderRadius: RADIUS.md, overflow: 'hidden',
    backgroundColor: c.surfaceLight,
  },
  thumb: { width: '100%', height: '100%' },
  caption: { color: c.text, fontSize: 13, fontWeight: '700', lineHeight: 17, marginTop: 6 },
  author: { color: c.textTertiary, fontSize: 11, marginTop: 1 },

  playBadge: {
    position: 'absolute', top: 7, left: 7, width: 24, height: 24, borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center',
  },
  empty: { alignItems: 'center', gap: 10, marginTop: 40 },
  emptyText: { color: c.textTertiary, fontSize: 13, textAlign: 'center', paddingHorizontal: 30 },
});
