import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList, ScrollView, Dimensions, RefreshControl, Animated } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { usePostOptions } from '../contexts/PostOptionsContext';
import { isSwipeTap } from '../contexts/PagerContext';
import { openAdOptions } from '../contexts/AdOptionsContext';
import { adDestination, recordAdImpression, type AdMeta } from '../lib/ads';
import VideoThumb from './VideoThumb';
import AppVideo from './AppVideo';
import TVAdViewer from './TVAdViewer';
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
  // Present on woven Laybell TV sponsored cards (lib/ads.tvItemFor).
  __ad?: AdMeta;
};

const H_PADDING = SPACING.md;
const GRID_GAP = SPACING.sm;
const SCREEN_W = Dimensions.get('window').width;
// 2-up landscape grid cell.
const COL_W = (SCREEN_W - H_PADDING * 2 - GRID_GAP) / 2;
const COL_THUMB_H = COL_W * (9 / 16);
// ONE tile geometry for both shelves — wide 16:9.
//
// Recommended used to be a PORTRAIT tile (0.42 wide, ×1.3 tall), inherited from
// the reel grid. On Laybell TV that was backwards: this is the landscape
// surface, so every video in the row is 16:9 being shown in a 3:4 box — cropped
// or pillarboxed — and it sat directly above a Films row of wide posters, so the
// two shelves looked unrelated to each other on the same screen.
const FILM_W = Math.round((SCREEN_W - H_PADDING * 2) * 0.62);
const FILM_H = Math.round(FILM_W * (9 / 16));
const FEAT_W = FILM_W;
const FEAT_H = FILM_H;

// A film's runtime chip: h:mm:ss past the hour, m:ss under it.
function fmtRuntime(sec?: number | null): string {
  const s = Math.max(0, Math.round(sec ?? 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`
    : `${m}:${r.toString().padStart(2, '0')}`;
}

export default function TVVideoList({ posts, featured, films, currentUserId, refreshing, onRefresh, bottomPad, emptyText, onPostDeleted, castActive, onCast, castingId }: {
  posts: TVPost[];
  // Personalized top picks shown as portrait tiles above the grid (omit/empty to
  // hide the row — e.g. while searching).
  featured?: TVPost[];
  // The Films shelf (Premium+ long-form, >9 min) — wide poster tiles between
  // Recommended and the grid. Omit/empty to hide the shelf entirely.
  films?: TVPost[];
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
  // The post currently playing on the TV — its tile gets an "On TV" badge.
  castingId?: string | null;
}) {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { show: showOptions } = usePostOptions();
  // Tapping a sponsored card opens it fullscreen (dismissable) — the user chose
  // to watch, so it's optional (not forced) and the CTA lives inside the viewer.
  const [adViewer, setAdViewer] = useState<TVPost | null>(null);

  // Which sponsored cards are on screen — only those autoplay their video (so a
  // few muted ads play at a time, never every mounted one). Frozen callback +
  // set-equality check so scrolling through organic tiles doesn't re-render.
  const [visibleAdIds, setVisibleAdIds] = useState<Set<string>>(new Set());
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: any[] }) => {
    const ids = new Set<string>();
    for (const v of viewableItems) if (v.item?.__ad) ids.add(v.item.id);
    setVisibleAdIds((prev) => (prev.size === ids.size && [...ids].every((x) => prev.has(x)) ? prev : ids));
  }).current;

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

  // Corner badge: the tile playing on the TV right now gets a labeled "On TV"
  // chip; everything else keeps the plain play glyph.
  const badgeFor = (p: TVPost) =>
    castingId === p.id ? (
      <View style={styles.onTvBadge}>
        <Ionicons name="tv" size={10} color="#fff" />
        <Text style={styles.onTvText}>{t('tv.onTv')}</Text>
      </View>
    ) : (
      <View style={styles.playBadge}><Ionicons name="play" size={12} color="#fff" /></View>
    );

  const longPressFor = (p: TVPost) =>
    currentUserId
      ? () => showOptions({
          postId: p.id,
          isOwn: p.user_id === currentUserId,
          authorId: p.user_id,
          authorName: p.profiles?.username ?? undefined,
          mediaType: p.type,
          hideMakeGif: true, // Laybell TV surface — GIF preview can't load here
          onEdit: () => router.push(`/edit-post/${p.id}`),
          onDeleted: () => onPostDeleted?.(p.id),
          onArchived: () => onPostDeleted?.(p.id),
          onBlocked: () => onPostDeleted?.(p.id),
        })
      : undefined;

  const feat = featured ?? [];
  const filmRows = films ?? [];
  const header = feat.length > 0 || filmRows.length > 0 ? (
    <View style={styles.featSection}>
      {feat.length > 0 && (
        <>
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
                {badgeFor(p)}
                {/* Same treatment as a Films tile: the name leads, the author
                    sits under it. A caption stands in for the title here, since
                    an ordinary video has no film_title. */}
                <LinearGradient colors={['transparent', 'rgba(0,0,0,0.85)']} style={styles.featOverlay}>
                  {!!(p.caption || p.profiles?.display_name) && (
                    <Text style={styles.filmName} numberOfLines={1}>
                      {p.caption || p.profiles?.display_name}
                    </Text>
                  )}
                  {!!p.profiles?.username && <Text style={styles.featUser} numberOfLines={1}>@{p.profiles.username}</Text>}
                </LinearGradient>
                {!!(p as any).duration_seconds && (
                  <View style={styles.filmRuntime}>
                    <Text style={styles.filmRuntimeText}>{fmtRuntime((p as any).duration_seconds)}</Text>
                  </View>
                )}
                <ThumbStat type={p.type} viewCount={p.view_count} streamCount={p.stream_count} />
              </TouchableOpacity>
            ))}
          </ScrollView>
        </>
      )}
      {/* FILMS — the Premium+ long-form shelf. Wide poster tiles: title over a
          heavier scrim (a film leads with its NAME, not its author) + runtime. */}
      {filmRows.length > 0 && (
        <View style={[styles.filmSection, feat.length > 0 && { marginTop: SPACING.md }]}>
          {/* The shelf header doubles as the way in: Films is the flagship
              Premium+ surface, so it gets a bigger title, its own raised
              plate, and a chevron that says "there is more of this". */}
          <TouchableOpacity
            style={styles.filmHeader}
            activeOpacity={0.75}
            accessibilityRole="button"
            onPress={() => router.push('/films' as any)}
          >
            <View style={styles.filmHeaderLeft}>
              <Text style={styles.filmSectionTitle}>{t('tv.films')}</Text>
            </View>
            <View style={styles.filmSeeAll}>
              <Text style={styles.filmSeeAllText}>{t('tv.seeAll')}</Text>
              <Ionicons name="chevron-forward" size={16} color={colors.text} />
            </View>
          </TouchableOpacity>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.featRow}
          >
            {filmRows.map((p) => (
              <TouchableOpacity
                key={p.id}
                style={styles.filmTile}
                activeOpacity={0.9}
                onPress={(e: any) => openVideo(p, e, FILM_W, FILM_H)}
                onLongPress={longPressFor(p)}
              >
                <VideoThumb thumbnailUrl={p.thumbnail_url} mediaUrl={p.media_url} style={styles.filmThumb} />
                {badgeFor(p)}
                <LinearGradient colors={['transparent', 'rgba(0,0,0,0.85)']} style={styles.filmOverlay}>
                  <Text style={styles.filmName} numberOfLines={1}>
                    {(p as any).film_title || p.caption || p.profiles?.display_name || p.profiles?.username || ''}
                  </Text>
                  {!!p.profiles?.username && <Text style={styles.featUser} numberOfLines={1}>@{p.profiles.username}</Text>}
                </LinearGradient>
                <View style={styles.filmRuntime}>
                  <Text style={styles.filmRuntimeText}>{fmtRuntime((p as any).duration_seconds)}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}
      {posts.length > 0 && <Text style={styles.gridTitle}>{t('tv.moreVideos')}</Text>}
    </View>
  ) : null;

  return (
    <>
    <FlatList
      data={posts}
      keyExtractor={(p) => p.id}
      numColumns={2}
      columnWrapperStyle={styles.rowWrap}
      contentContainerStyle={[styles.content, { paddingBottom: (bottomPad ?? 0) + SPACING.xxl }]}
      showsVerticalScrollIndicator={false}
      ListHeaderComponent={header}
      onViewableItemsChanged={onViewableItemsChanged}
      viewabilityConfig={viewabilityConfig}
      refreshControl={
        onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} /> : undefined
      }
      renderItem={({ item: p }) => {
        // Woven sponsored card — autoplays its video while on screen; tapping opens
        // it fullscreen to watch (optional, dismissable), not the reel viewer.
        if (p.__ad) return <TVAdCard ad={p} active={visibleAdIds.has(p.id)} styles={styles} colors={colors} t={t} uid={currentUserId ?? null} onPress={() => setAdViewer(p)} />;
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
              {badgeFor(p)}
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
    <TVAdViewer item={adViewer} uid={currentUserId ?? null} onClose={() => setAdViewer(null)} />
    </>
  );
}

// Sponsored landscape card woven into the TV grid. Unlike organic tiles (static
// thumbnails), the ad AUTOPLAYS its video inline (muted, looping) so it actually
// "plays" like the reel ad — but only while on screen (active), so off-screen
// ads don't burn video decoders. Sponsored pill + CTA chip mark it as an ad;
// bills one impression on mount.
function TVAdCard({ ad, active, styles, colors, t, uid, onPress }: {
  ad: TVPost; active: boolean; styles: any; colors: ThemePalette;
  t: (k: string, v?: any) => string; uid: string | null; onPress: () => void;
}) {
  const meta = ad.__ad!;
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => { recordAdImpression(ad, 'tv', uid); }, [ad.id]);
  return (
    <TouchableOpacity style={styles.card} activeOpacity={0.9} onPress={onPress}>
      <View style={styles.thumbWrap}>
        {/* Thumbnail underneath for an instant frame; the video fades in over it. */}
        <VideoThumb thumbnailUrl={ad.thumbnail_url} mediaUrl={ad.media_url} style={StyleSheet.absoluteFill} />
        {!!ad.media_url && (
          <AppVideo
            source={{ uri: ad.media_url }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            active={active}
            loop
            muted
            poster={ad.thumbnail_url ?? undefined}
            posterContentFit="cover"
            onProgress={(pos, dur) => { if (dur > 0) progress.setValue(Math.min(1, pos / dur)); }}
          />
        )}
        <View style={styles.sponsoredPill}>
          <Ionicons name="megaphone" size={9} color="#fff" />
          <Text style={styles.sponsoredText}>{t('ad.sponsored')}</Text>
        </View>
        {/* 3-dot report — tap it (not the card) to open the ad options sheet. */}
        <TouchableOpacity
          style={styles.adOptBtn}
          onPress={() => openAdOptions({ campaignId: meta.campaignId, creativeId: meta.creativeId, advertiserName: meta.advertiserName })}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="ellipsis-horizontal" size={16} color="#fff" />
        </TouchableOpacity>
        {/* Inline video progress. */}
        <View style={styles.adProgressTrack}>
          <Animated.View style={[styles.adProgressFill, { width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]} />
        </View>
      </View>
      <Text style={styles.caption} numberOfLines={2}>{meta.headline || meta.advertiserName}</Text>
      <View style={styles.adFootRow}>
        <Text style={styles.adAdvertiser} numberOfLines={1}>{meta.advertiserName}</Text>
        {/* Chip mirrors whether a CTA destination exists at all — ctaUrl alone
            hid it for profile/shop/product ads. */}
        {!!adDestination(ad) && (
          <View style={styles.adCtaChip}>
            <Text style={styles.adCtaText} numberOfLines={1}>{meta.ctaLabel}</Text>
            <Ionicons name="arrow-forward" size={10} color={colors.primary} />
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  content: { paddingHorizontal: H_PADDING, paddingTop: 2 },
  rowWrap: { gap: GRID_GAP, marginBottom: SPACING.lg },

  // Recommended (portrait) carousel
  featSection: { marginBottom: SPACING.sm },
  // A middle rung: bigger than "More videos" (15), clearly under the Films
  // wordmark (30/900). Recommended is the first thing on the screen and should
  // carry some weight, but Films has to stay the loudest thing on the page.
  featTitle: { color: c.text, fontSize: 20, fontWeight: '800', letterSpacing: -0.3, marginBottom: SPACING.sm },

  // ── Films shelf ────────────────────────────────────────────────────────────
  // No card, no border, no plate — the boxed version fought the tiles beneath
  // it and made the shelf look like a widget dropped into the page. The weight
  // comes from TYPE instead: a 30pt near-black wordmark that simply dwarfs the
  // 15pt labels on every other row. Big type reads as a section; a box reads as
  // a component.
  filmSection: {
    marginBottom: SPACING.md,
  },
  filmHeader: {
    flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between',
    paddingRight: H_PADDING,
    paddingBottom: SPACING.sm,
  },
  filmHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  filmSectionTitle: {
    color: c.text,
    fontSize: 30,
    fontWeight: '900',
    // Tight tracking keeps a big word feeling designed rather than merely large.
    letterSpacing: -0.6,
  },
  filmSeeAll: { flexDirection: 'row', alignItems: 'center', gap: 1, paddingBottom: 4 },
  // Neutral in both themes — white on dark, near-black on light. "See all" is
  // navigation, not a terminal action, so it does not spend the accent.
  filmSeeAllText: { color: c.text, fontSize: 14, fontWeight: '800' },
  featRow: { gap: GRID_GAP, paddingRight: H_PADDING },
  featTile: {
    width: FEAT_W, height: FEAT_H, borderRadius: RADIUS.md, overflow: 'hidden',
    backgroundColor: c.surfaceLight,
  },
  featThumb: { width: '100%', height: '100%' },
  // Matches filmOverlay exactly — same scrim height and padding, so the two
  // shelves read as one system rather than two components that happen to share
  // a screen.
  featOverlay: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xl, paddingBottom: 6, gap: 1,
  },
  featUser: { color: '#fff', fontSize: 11, fontWeight: '600' },

  // Films shelf (wide poster tiles)
  filmTile: {
    width: FILM_W, height: FILM_H, borderRadius: RADIUS.md, overflow: 'hidden',
    backgroundColor: c.surfaceLight,
  },
  filmThumb: { width: '100%', height: '100%' },
  filmOverlay: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xl, paddingBottom: 6, gap: 1,
  },
  filmName: { color: '#fff', fontSize: 13.5, fontWeight: '800', letterSpacing: -0.2 },
  filmRuntime: {
    position: 'absolute', top: SPACING.sm, right: SPACING.sm,
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: RADIUS.sm,
    paddingHorizontal: 6, paddingVertical: 2,
  },
  filmRuntimeText: { color: '#fff', fontSize: 10.5, fontWeight: '700', fontVariant: ['tabular-nums'] },

  // The bottom rung of the page's type scale: Films 30 → Recommended 20 →
  // More videos 18. Each step is visible without any two reading as peers.
  gridTitle: { color: c.text, fontSize: 18, fontWeight: '800', letterSpacing: -0.2, marginTop: SPACING.md },

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
  onTvBadge: {
    position: 'absolute', top: 7, left: 7, height: 24, borderRadius: 12,
    backgroundColor: c.primary, flexDirection: 'row', alignItems: 'center',
    gap: 4, paddingHorizontal: 8,
  },
  onTvText: { color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 0.3 },

  // Sponsored TV card
  sponsoredPill: {
    position: 'absolute', top: 7, left: 7, flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3,
  },
  sponsoredText: { color: '#fff', fontSize: 9, fontWeight: '800', letterSpacing: 0.3 },
  adOptBtn: {
    position: 'absolute', top: 5, right: 5, width: 24, height: 24, borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center',
  },
  adProgressTrack: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 2.5, backgroundColor: 'rgba(255,255,255,0.25)' },
  adProgressFill: { height: 2.5, backgroundColor: c.primary },
  adFootRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginTop: 1 },
  adAdvertiser: { flex: 1, color: c.textTertiary, fontSize: 11 },
  adCtaChip: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  adCtaText: { color: c.primary, fontSize: 11, fontWeight: '700' },

  empty: { alignItems: 'center', gap: 10, marginTop: 40 },
  emptyText: { color: c.textTertiary, fontSize: 13, textAlign: 'center', paddingHorizontal: 30 },
});
