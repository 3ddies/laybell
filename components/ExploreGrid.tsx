import {
  View, Text, StyleSheet, Image, TouchableOpacity, ScrollView, Dimensions, RefreshControl,
} from 'react-native';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Video, ResizeMode } from 'expo-av';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { aspectToNumber } from '../lib/aspectRatio';
import { useAudio } from '../contexts/AudioContext';
import { formatCount } from '../lib/format';
import { usePostOptions } from '../contexts/PostOptionsContext';
import { isSwipeTap } from '../contexts/PagerContext';
import { isAudioPost } from '../lib/genres';
import { trackVideoProgress } from '../lib/viewTracker';
import ThumbStat from './ThumbStat';
import VideoThumb from './VideoThumb';
import { isSlideshow, slideshowThumb } from '../lib/slideshow';

type GridPost = {
  id: string; type: string; media_url: string; caption: string;
  thumbnail_url?: string | null; aspect_ratio?: string | null; cover_url?: string | null;
  slides?: any; // slideshow media list (drives the still cover via slideshowThumb)
  stream_count?: number; view_count?: number; user_id?: string;
  profiles?: { username: string; display_name: string } | null;
};

const GAP = 6;
const H_PADDING = SPACING.md;
const COL_W = (Dimensions.get('window').width - H_PADDING * 2 - GAP) / 2;
const COL3_W = (Dimensions.get('window').width - H_PADDING * 2 - GAP * 2) / 3; // genre 3-up grid
const ROW_H = COL_W / 3;            // a song row is 1/3 of a picture tile
const MUSIC_HEADER_H = 30;
const VIDEO_GAP = 3;                // min non-video cells between videos

type Cell =
  | { kind: 'media'; key: string; post: GridPost; height: number }
  | { kind: 'music'; key: string; title: string; songs: GridPost[]; height: number };

function groupSongs(songs: GridPost[]): GridPost[][] {
  const groups: GridPost[][] = [];
  let i = 0;
  while (i < songs.length) {
    let size = Math.min(4, songs.length - i);
    if (songs.length - i - size === 1 && size > 2) size -= 1;
    groups.push(songs.slice(i, i + size));
    i += size;
  }
  return groups;
}

function mediaHeight(post: GridPost): number {
  if (post.type === 'video') return Math.min(COL_W / aspectToNumber(post.aspect_ratio, 16 / 9), COL_W * 1.25);
  return COL_W; // pictures render 1:1
}

export default function ExploreGrid({ posts, refreshing, onRefresh, songTiles, songClusters, onClusterSongPlay, currentUserId, onPostDeleted, header }: {
  posts: GridPost[]; refreshing?: boolean; onRefresh?: () => void; songTiles?: boolean;
  // Pre-built genre clusters (title + songs) replacing the generic
  // "Trending Songs" stacks in the All view; plays report back for the
  // 3h/24h refresh window.
  songClusters?: { title: string; songs: GridPost[] }[];
  onClusterSongPlay?: () => void;
  currentUserId?: string | null; onPostDeleted?: (id: string) => void; header?: ReactNode;
}) {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { play: playRaw, currentTrack, isPlaying } = useAudio();
  // Swipe-tap guard: a tab swipe gliding over the grid must not start audio.
  const play: typeof playRaw = (t) => (isSwipeTap() ? Promise.resolve() : playRaw(t));
  const { show: showOptions } = usePostOptions();

  const longPressFor = (p: GridPost) =>
    currentUserId
      ? () => showOptions({
          postId: p.id,
          isOwn: p.user_id === currentUserId,
          authorId: p.user_id,
          authorName: p.profiles?.username,
          mediaType: p.type,
          onEdit: () => router.push(`/edit-post/${p.id}`),
          onDeleted: () => onPostDeleted?.(p.id),
          onArchived: () => onPostDeleted?.(p.id),
          onBlocked: () => onPostDeleted?.(p.id),
        })
      : undefined;

  // Videos open the full-screen reel feed; other media opens the post detail.
  // The press event gives the tapped cell's top-left (pageX/Y − locationX/Y) so the
  // viewer can expand out of / shrink back into the thumbnail (Instagram-style).
  const openMedia = (p: GridPost, e?: any) => {
    if (isSwipeTap()) return; // a swipe glide must not open the viewer
    const ne = e?.nativeEvent;
    const src = ne
      ? JSON.stringify({ x: ne.pageX - ne.locationX, y: ne.pageY - ne.locationY, width: COL_W, height: COL_W })
      : undefined;
    const pathname = p.type === 'video' ? '/reel/[id]' : '/post/[id]';
    // Seed the post so the viewer renders its thumbnail/poster instantly (no black
    // screen while it fetches) as it expands.
    router.push({ pathname, params: { id: p.id, post: JSON.stringify(p), ...(src ? { src } : {}) } });
  };

  // Videos that currently overlap the viewport (these play). Off-screen videos
  // stay mounted but paused, so scrolling back resumes smoothly.
  const [visibleIds, setVisibleIds] = useState<Set<string>>(new Set());
  const mountedIds = useRef<Set<string>>(new Set()); // once visible, keep the <Video> mounted
  const scrollY = useRef(0);
  const viewportH = useRef(0);
  const videoPos = useRef<Record<string, { y: number; h: number }>>({});

  const recomputeActive = () => {
    const top = scrollY.current;
    const bottom = top + viewportH.current;
    const next = new Set<string>();
    for (const id in videoPos.current) {
      const { y, h } = videoPos.current[id];
      if (y < bottom && y + h > top) { next.add(id); mountedIds.current.add(id); }
    }
    setVisibleIds(prev => {
      if (prev.size === next.size && [...next].every(id => prev.has(id))) return prev;
      return next;
    });
  };

  // The masonry layout depends only on the posts and the songTiles mode, not on
  // playback state — so memoize it. Without this the whole filter/sort/group/pack
  // recomputed on every render, including each 250ms audio progress tick.
  const { cols, playableSet } = useMemo(() => {
    if (!posts || posts.length === 0) {
      return { cols: [[], []] as Cell[][], playableSet: new Set<string>() };
    }

    const videos = posts.filter(p => p.type === 'video');
    // Images + slideshows render as 1:1 STILL tiles — a slideshow is never a video,
    // so it never live-loops (always a static cover). In genre view songs join them
    // as cover tiles; in "All" they stay grouped into Trending Songs stacks.
    const stillTiles = posts.filter(p => p.type === 'image' || isSlideshow(p.type));
    const tileMedia = songTiles
      ? posts.filter(p => p.type === 'image' || isSlideshow(p.type) || isAudioPost(p.type))
      : stillTiles;
    // Genre clusters (when provided) supersede the grouped-from-feed stacks.
    const musicGroups: { title: string; songs: GridPost[] }[] = songTiles
      ? []
      : songClusters && songClusters.length > 0
      ? songClusters
      : groupSongs(posts.filter(p => isAudioPost(p.type))).map(g => ({ title: 'Trending Songs', songs: g }));

    // Only ~1 in every 4 videos auto-plays; the rest stay as still thumbnails so the
    // grid isn't overstimulating. Prefer vertical (portrait) clips for the play
    // slots since they look better on the grid.
    const playableCount = Math.ceil(videos.length / 4);
    const isVertical = (p: GridPost) => aspectToNumber(p.aspect_ratio, 16 / 9) < 1; // w/h < 1 => portrait
    const playableSet = new Set(
      [...videos]
        .sort((a, b) => Number(isVertical(b)) - Number(isVertical(a))) // verticals first
        .slice(0, playableCount)
        .map(v => v.id),
    );

    // Base (non-video) cells: interleave the 1:1 tiles and (in All view) music stacks.
    const baseCells: Cell[] = [];
    let mi = 0;
    tileMedia.forEach((m, idx) => {
      baseCells.push({ kind: 'media', key: m.id, post: m, height: mediaHeight(m) });
      if (idx % 2 === 1 && mi < musicGroups.length) {
        const g = musicGroups[mi];
        baseCells.push({ kind: 'music', key: `music-${mi}`, title: g.title, songs: g.songs, height: MUSIC_HEADER_H + g.songs.length * ROW_H });
        mi++;
      }
    });
    while (mi < musicGroups.length) {
      const g = musicGroups[mi];
      baseCells.push({ kind: 'music', key: `music-${mi}`, title: g.title, songs: g.songs, height: MUSIC_HEADER_H + g.songs.length * ROW_H });
      mi++;
    }

    // Masonry the base cells; splice videos in on alternating sides, spaced apart.
    const cols: Cell[][] = [[], []];
    const colH = [0, 0];
    let videoSide = 0;
    let sinceVideo = VIDEO_GAP; // allow a video early
    let vi = 0;
    const placeVideo = () => {
      const v = videos[vi++];
      const h = mediaHeight(v);
      cols[videoSide].push({ kind: 'media', key: v.id, post: v, height: h });
      colH[videoSide] += h + GAP;
      videoSide ^= 1;
      sinceVideo = 0;
    };
    for (const cell of baseCells) {
      const c = colH[0] <= colH[1] ? 0 : 1;
      cols[c].push(cell);
      colH[c] += cell.height + GAP;
      sinceVideo++;
      if (vi < videos.length && sinceVideo >= VIDEO_GAP) placeVideo();
    }
    while (vi < videos.length) placeVideo();

    return { cols, playableSet };
  }, [posts, songTiles, songClusters]);

  if (!posts || posts.length === 0) {
    return (
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
        refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} /> : undefined}
      >
        {header}
        <View style={styles.empty}><Text style={styles.emptyText}>No posts in this genre yet</Text></View>
      </ScrollView>
    );
  }

  const renderMedia = (cell: Cell & { kind: 'media' }) => {
    const p = cell.post;
    if (p.type === 'video' && !playableSet.has(p.id)) {
      // Still thumbnail — never plays.
      return (
        <TouchableOpacity
          key={cell.key}
          style={[styles.mediaCard, { height: cell.height }]}
          activeOpacity={0.9}
          onPress={(e: any) => openMedia(p, e)}
        >
          {/* VideoThumb generates a frame when thumbnail_url is missing, so still
              (non-autoplaying) videos always show a preview — not a placeholder. */}
          <VideoThumb thumbnailUrl={p.thumbnail_url} mediaUrl={p.media_url} style={styles.mediaImage} />
          <View style={styles.playBadge}><Ionicons name="play" size={12} color="#fff" /></View>
          <LinearGradient colors={['transparent', 'rgba(0,0,0,0.75)']} style={styles.mediaOverlay}>
            <Text style={styles.mediaUser} numberOfLines={1}>@{p.profiles?.username}</Text>
          </LinearGradient>
          <ThumbStat type={p.type} viewCount={p.view_count} streamCount={p.stream_count} />
        </TouchableOpacity>
      );
    }
    if (p.type === 'video') {
      const mounted = mountedIds.current.has(p.id);
      const playing = visibleIds.has(p.id);
      return (
        <TouchableOpacity
          key={cell.key}
          style={[styles.mediaCard, { height: cell.height }]}
          activeOpacity={0.9}
          onPress={(e: any) => openMedia(p, e)}
          onLayout={e => { videoPos.current[p.id] = { y: e.nativeEvent.layout.y, h: cell.height }; recomputeActive(); }}
        >
          {mounted ? (
            <Video
              source={{ uri: p.media_url }}
              style={styles.mediaImage}
              resizeMode={ResizeMode.COVER}
              isLooping isMuted
              shouldPlay={playing}
              // Muted grid autoplay counts toward views — genuine watch time
              // accumulates app-wide; the server enforces the fairness caps.
              onPlaybackStatusUpdate={(st: any) => {
                if (st?.isLoaded) trackVideoProgress(p.id, st.positionMillis ?? 0, st.durationMillis ?? 0);
              }}
            />
          ) : (
            <VideoThumb thumbnailUrl={p.thumbnail_url} mediaUrl={p.media_url} style={styles.mediaImage} />
          )}
          <View style={styles.playBadge}><Ionicons name="play" size={12} color="#fff" /></View>
          <LinearGradient colors={['transparent', 'rgba(0,0,0,0.75)']} style={styles.mediaOverlay}>
            <Text style={styles.mediaUser} numberOfLines={1}>@{p.profiles?.username}</Text>
          </LinearGradient>
          <ThumbStat type={p.type} viewCount={p.view_count} streamCount={p.stream_count} />
        </TouchableOpacity>
      );
    }
    if (isAudioPost(p.type)) {
      // Song shown as a 1:1 cover tile (genre view) — tap to play.
      const active = currentTrack?.id === p.id && isPlaying;
      return (
        <TouchableOpacity
          key={cell.key}
          style={[styles.mediaCard, { height: cell.height }]}
          activeOpacity={0.9}
          onPress={() => play({ id: p.id, uri: p.media_url, caption: p.caption, artist: p.profiles?.display_name ?? '', cover: p.cover_url })}
          onLongPress={longPressFor(p)}
        >
          {p.cover_url ? (
            <Image source={{ uri: p.cover_url }} style={styles.mediaImage} resizeMode="cover" />
          ) : (
            <LinearGradient colors={GRADIENTS.primarySoft} style={styles.mediaImage}>
              <Ionicons name="musical-notes" size={28} color={colors.primary} />
            </LinearGradient>
          )}
          <View style={styles.playBadge}><Ionicons name={active ? 'pause' : 'musical-notes'} size={12} color="#fff" /></View>
          <LinearGradient colors={['transparent', 'rgba(0,0,0,0.75)']} style={styles.mediaOverlay}>
            <Text style={styles.mediaUser} numberOfLines={1}>{p.caption || `@${p.profiles?.username}`}</Text>
          </LinearGradient>
        </TouchableOpacity>
      );
    }
    if (isSlideshow(p.type)) {
      // Slideshow: ALWAYS a still cover (slide 1's image / video poster), never a
      // live loop. Tap opens the post detail (carousel) like any image post.
      const thumb = slideshowThumb(p);
      return (
        <TouchableOpacity
          key={cell.key}
          style={[styles.mediaCard, { height: cell.height }]}
          activeOpacity={0.9}
          onPress={(e: any) => openMedia(p, e)}
        >
          {thumb ? (
            <Image source={{ uri: thumb }} style={styles.mediaImage} resizeMode="cover" />
          ) : (
            <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.mediaImage}>
              <Ionicons name="copy" size={28} color={colors.primary} />
            </LinearGradient>
          )}
          <View style={styles.playBadge}><Ionicons name="copy" size={12} color="#fff" /></View>
          <LinearGradient colors={['transparent', 'rgba(0,0,0,0.75)']} style={styles.mediaOverlay}>
            <Text style={styles.mediaUser} numberOfLines={1}>@{p.profiles?.username}</Text>
          </LinearGradient>
        </TouchableOpacity>
      );
    }
    return (
      <TouchableOpacity
        key={cell.key}
        style={[styles.mediaCard, { height: cell.height }]}
        activeOpacity={0.9}
        onPress={(e: any) => openMedia(p, e)}
      >
        <Image source={{ uri: p.media_url }} style={styles.mediaImage} resizeMode="cover" />
        <LinearGradient colors={['transparent', 'rgba(0,0,0,0.75)']} style={styles.mediaOverlay}>
          <Text style={styles.mediaUser} numberOfLines={1}>@{p.profiles?.username}</Text>
        </LinearGradient>
      </TouchableOpacity>
    );
  };

  const renderCell = (cell: Cell) => {
    if (cell.kind === 'music') {
      return (
        <View key={cell.key} style={[styles.musicCard, { height: cell.height }]}>
          {/* Centered genre word — heavy urban cut in the logo color */}
          <View style={styles.musicHeader}>
            <Text style={styles.musicHeaderText} numberOfLines={1}>{cell.title}</Text>
          </View>
          {cell.songs.map((s, i) => {
            const active = currentTrack?.id === s.id && isPlaying;
            return (
              <TouchableOpacity
                key={s.id}
                style={[styles.songRow, { height: ROW_H }, i > 0 && styles.songRowBorder]}
                onPress={() => {
                  play({ id: s.id, uri: s.media_url, caption: s.caption, artist: s.profiles?.display_name ?? '', cover: s.cover_url });
                  onClusterSongPlay?.();
                }}
                onLongPress={longPressFor(s)}
              >
                {s.cover_url ? (
                  <View style={styles.songIcon}>
                    <Image source={{ uri: s.cover_url }} style={styles.songCoverImg} />
                    {active && (
                      <View style={styles.songCoverOverlay}>
                        <Ionicons name="stop" size={15} color={colors.text} />
                      </View>
                    )}
                  </View>
                ) : (
                  <LinearGradient colors={active ? GRADIENTS.primary : GRADIENTS.primarySoft} style={styles.songIcon}>
                    <Ionicons name={active ? 'stop' : 'musical-notes'} size={16} color={active ? colors.text : colors.primary} />
                  </LinearGradient>
                )}
                <View style={styles.songInfo}>
                  <Text style={styles.songTitle} numberOfLines={1}>{s.caption || 'Audio Track'}</Text>
                  <View style={styles.songMeta}>
                    <Text style={styles.songArtist} numberOfLines={1}>@{s.profiles?.username}</Text>
                    <Ionicons name="play" size={9} color={colors.textTertiary} />
                    <Text style={styles.songStreams}>{formatCount(s.stream_count)}</Text>
                  </View>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      );
    }
    return renderMedia(cell);
  };

  // Genre view: a uniform 3-up square grid.
  const renderSquare = (p: GridPost) => {
    if (isAudioPost(p.type)) {
      const active = currentTrack?.id === p.id && isPlaying;
      return (
        <TouchableOpacity
          key={p.id}
          style={styles.square}
          activeOpacity={0.9}
          onPress={() => play({ id: p.id, uri: p.media_url, caption: p.caption, artist: p.profiles?.display_name ?? '', cover: p.cover_url })}
          onLongPress={longPressFor(p)}
        >
          {p.cover_url ? (
            <Image source={{ uri: p.cover_url }} style={styles.mediaImage} resizeMode="cover" />
          ) : (
            <LinearGradient colors={GRADIENTS.primarySoft} style={styles.mediaImage}>
              <Ionicons name="musical-notes" size={24} color={colors.primary} />
            </LinearGradient>
          )}
          <View style={styles.squareBadge}><Ionicons name={active ? 'pause' : 'musical-notes'} size={11} color="#fff" /></View>
          <View style={styles.squareTitleBar}>
            <Text style={styles.squareTitleText} numberOfLines={1}>{p.caption || 'Audio Track'}</Text>
          </View>
        </TouchableOpacity>
      );
    }
    if (p.type === 'video') {
      return (
        <TouchableOpacity key={p.id} style={styles.square} activeOpacity={0.9} onPress={(e: any) => openMedia(p, e)}>
          <VideoThumb thumbnailUrl={p.thumbnail_url} mediaUrl={p.media_url} style={styles.mediaImage} />
          <View style={styles.squareBadge}><Ionicons name="play" size={11} color="#fff" /></View>
        </TouchableOpacity>
      );
    }
    if (isSlideshow(p.type)) {
      const thumb = slideshowThumb(p);
      return (
        <TouchableOpacity key={p.id} style={styles.square} activeOpacity={0.9} onPress={(e: any) => openMedia(p, e)}>
          {thumb ? (
            <Image source={{ uri: thumb }} style={styles.mediaImage} resizeMode="cover" />
          ) : (
            <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.mediaImage}>
              <Ionicons name="copy" size={24} color={colors.primary} />
            </LinearGradient>
          )}
          <View style={styles.squareBadge}><Ionicons name="copy" size={11} color="#fff" /></View>
        </TouchableOpacity>
      );
    }
    return (
      <TouchableOpacity key={p.id} style={styles.square} activeOpacity={0.9} onPress={(e: any) => openMedia(p, e)}>
        <Image source={{ uri: p.media_url }} style={styles.mediaImage} resizeMode="cover" />
      </TouchableOpacity>
    );
  };

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.scroll}
      scrollEventThrottle={16}
      onScroll={e => { scrollY.current = e.nativeEvent.contentOffset.y; recomputeActive(); }}
      onLayout={e => { viewportH.current = e.nativeEvent.layout.height; recomputeActive(); }}
      refreshControl={
        onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} /> : undefined
      }
    >
      {header}
      {songTiles ? (
        <View style={styles.grid3}>{posts.map(renderSquare)}</View>
      ) : (
        <View style={styles.row}>
          {cols.map((col, ci) => (
            <View key={ci} style={styles.col}>{col.map(renderCell)}</View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  scroll: { padding: H_PADDING, paddingBottom: SPACING.xxl },
  row: { flexDirection: 'row', gap: GAP },
  col: { width: COL_W, gap: GAP },
  grid3: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP },
  square: { width: COL3_W, height: COL3_W, borderRadius: RADIUS.sm, overflow: 'hidden', backgroundColor: colors.surfaceLight },
  squareBadge: {
    position: 'absolute', top: 6, left: 6, width: 20, height: 20, borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center',
  },
  squareTitleBar: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 6, paddingVertical: 4,
  },
  squareTitleText: { color: '#FFFFFF', fontSize: 11, fontWeight: '600' },

  mediaCard: { width: COL_W, borderRadius: RADIUS.md, overflow: 'hidden', backgroundColor: colors.surfaceLight },
  mediaImage: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
  playBadge: {
    position: 'absolute', top: 8, left: 8, width: 22, height: 22, borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center',
  },
  mediaOverlay: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.lg, paddingBottom: 6,
  },
  // Always white — it sits on a dark gradient overlay over the media in every
  // theme, so the themed (black-in-light) text color would be unreadable there.
  mediaUser: { color: '#fff', fontSize: 11, fontWeight: '600' },

  musicCard: {
    width: COL_W, borderRadius: RADIUS.md, overflow: 'hidden',
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
  },
  // Centered genre word: heavy black-italic cut in the Laybell-logo color —
  // no banner background, the type carries the card header on its own.
  musicHeader: {
    height: MUSIC_HEADER_H, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: SPACING.sm,
    backgroundColor: colors.primary,
  },
  // Logo-yellow word on the bright orange: a tight dark drop shadow lifts the
  // letters off the banner (raised-print look) so they stay crisp despite the
  // two brand colors sitting close in brightness.
  musicHeaderText: {
    color: colors.primaryLight, fontSize: 14, fontWeight: '900', fontStyle: 'italic',
    textTransform: 'uppercase', letterSpacing: 1.6,
    textShadowColor: 'rgba(60, 18, 2, 0.85)',
    textShadowOffset: { width: 0, height: 1.5 },
    textShadowRadius: 2,
  },
  songRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingHorizontal: SPACING.sm },
  songRowBorder: { borderTopWidth: 0.5, borderTopColor: colors.border },
  songIcon: { width: 32, height: 32, borderRadius: RADIUS.sm, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  songCoverImg: { width: 32, height: 32 },
  songCoverOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.3)',
  },
  songInfo: { flex: 1 },
  songTitle: { color: colors.text, fontSize: 12, fontWeight: '700' },
  songMeta: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 1 },
  songArtist: { color: colors.textSecondary, fontSize: 11 },
  songStreams: { color: colors.textTertiary, fontSize: 10 },

  empty: { alignItems: 'center', paddingTop: SPACING.xxl },
  emptyText: { color: colors.textTertiary, fontSize: 14 },
});
