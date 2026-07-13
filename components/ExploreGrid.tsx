import {
  View, Text, StyleSheet, Image, TouchableOpacity, ScrollView, Dimensions, RefreshControl,
} from 'react-native';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import AppVideo from './AppVideo';
import { feedDragEnd, feedDragStart, settleFeedChrome, trackFeedScroll } from '../lib/feedChrome';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { aspectToNumber } from '../lib/aspectRatio';
import { useAudio } from '../contexts/AudioContext';
import { formatCount } from '../lib/format';
import { usePostOptions } from '../contexts/PostOptionsContext';
import { isSwipeTap } from '../contexts/PagerContext';
import { isAudioPost } from '../lib/genres';
import { isHorizontalVideo } from '../lib/tv';
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
const SCREEN_H = Dimensions.get('window').height;
// Minimum vertical spacing between autoplay-eligible videos, so previews are
// spread evenly down the whole grid (never clumped, no long dead zones). ~0.6 of
// a screen → roughly one preview per screen as you scroll.
const PLAYABLE_GAP = SCREEN_H * 0.6;
// Full-width Laybell-TV hero banner: spans both columns at a 16:9 shape.
const BANNER_H = Math.round(((COL_W * 2 + GAP) * 9) / 16);
const COL3_W = (Dimensions.get('window').width - H_PADDING * 2 - GAP * 2) / 3; // genre 3-up grid
const ROW_H = COL_W / 3;            // a song row is 1/3 of a picture tile
const MUSIC_HEADER_H = 30;
// Never autoplay more than this many video previews at once on the grid — only
// the ones nearest the viewport center play, so previews never clump on screen.
const MAX_CONCURRENT_VIDEOS = 2;

// Layered black outline for the yellow header word — RN has no text stroke, so we
// stack offset black copies behind the fill (crisp, unlike a blurry text shadow).
const HEADER_STROKE = 1.6;
const HEADER_OUTLINE: ReadonlyArray<readonly [number, number]> = [
  [-HEADER_STROKE, 0], [HEADER_STROKE, 0], [0, -HEADER_STROKE], [0, HEADER_STROKE],
  [-HEADER_STROKE, -HEADER_STROKE], [HEADER_STROKE, -HEADER_STROKE],
  [-HEADER_STROKE, HEADER_STROKE], [HEADER_STROKE, HEADER_STROKE],
];
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

// Smooth weighted round-robin (error diffusion): deals the queues' items into ONE
// sequence, each queue spread evenly across it in proportion to its size, order
// preserved within a queue. Used for variety mixing AND for spreading horizontal
// video tiles among vertical ones so wide tiles never cluster.
function interleave<T>(queues: T[][]): T[] {
  const live = queues.filter(q => q.length > 0);
  const total = live.reduce((n, q) => n + q.length, 0);
  const st = live.map(q => ({ q, i: 0, credit: 0 }));
  const out: T[] = [];
  for (let step = 0; step < total; step++) {
    let pick: (typeof st)[number] | null = null;
    for (const x of st) {
      if (x.i >= x.q.length) continue; // spent queues stop competing
      x.credit += x.q.length;
      if (!pick || x.credit > pick.credit) pick = x;
    }
    if (!pick) break;
    pick.credit -= total;
    out.push(pick.q[pick.i++]);
  }
  return out;
}

// Laybell-TV banner caption. Renders at the BIGGER size first; if that wraps to
// more than one line, drops to the normal size (multi-line already looks right).
// So a single-line caption gets the slightly larger font, multi-line stays put.
// One-directional (big → normal), so it never flip-flops.
function TVCaption({ text }: { text: string }) {
  const styles = useThemedStyles(makeStyles);
  const [big, setBig] = useState(true);
  return (
    <Text
      style={[styles.tvCaption, big && styles.tvCaptionBig]}
      numberOfLines={2}
      onTextLayout={e => { if (big && e.nativeEvent.lines.length > 1) setBig(false); }}
    >
      {text}
    </Text>
  );
}

function mediaHeight(post: GridPost): number {
  if (post.type === 'video') {
    // Laybell-TV videos (landscape, aspect > 1) get a HORIZONTAL 16:9 tile so the
    // grid thumbnail resembles the video's real shape; vertical clips stay tall
    // reel tiles. Both fill via contentFit="cover".
    return isHorizontalVideo(post) ? Math.round((COL_W * 9) / 16) : COL_W * 1.25;
  }
  return COL_W; // pictures render 1:1
}

export default function ExploreGrid({ posts, refreshing, onRefresh, songTiles, songClusters, onClusterSongPlay, currentUserId, onPostDeleted, header, emptyText, trackChrome, bottomPad }: {
  posts: GridPost[]; refreshing?: boolean; onRefresh?: () => void; songTiles?: boolean;
  // Pre-built genre clusters (title + songs) replacing the generic
  // "Trending Songs" stacks in the All view; plays report back for the
  // 3h/24h refresh window.
  songClusters?: { title: string; songs: GridPost[] }[];
  onClusterSongPlay?: () => void;
  currentUserId?: string | null; onPostDeleted?: (id: string) => void; header?: ReactNode;
  // Override the empty-state line (defaults to the genre wording); callers like
  // the community grid pass their own so it doesn't duplicate a header message.
  emptyText?: string;
  // Explore TAB only: drive the reactive bottom-bar chrome from this grid's
  // scroll (other hosts — Saved, communities — must NOT touch the chrome).
  trackChrome?: boolean;
  // Extra bottom clearance when the host screen escapes the pager's bar
  // padding so content extends under the (condensable) tab bar.
  bottomPad?: number;
}) {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
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
  // Video onLayout y is COLUMN-relative. The grid is split into two sections (above
  // and below the Laybell-TV banner); each section's row measures its y in the
  // scroll content here, so a video's position converts to scroll-content coords as
  // sectionOffset + column-relative y (which section from bottomVideoIds below).
  const sectionOffsets = useRef({ top: 0, bottom: 0 });
  const videoPos = useRef<Record<string, { y: number; h: number }>>({});

  const recomputeActive = () => {
    const top = scrollY.current;
    const bottom = top + viewportH.current;
    const center = (top + bottom) / 2;
    const off = sectionOffsets.current;
    // Every video overlapping the viewport, with its distance from the viewport
    // center. Only the nearest few actually play (see MAX_CONCURRENT_VIDEOS) so a
    // cluster of previews never all render at once — the rest stay mounted but
    // paused on their poster. Playback tracks the center as you scroll.
    const overlapping: { id: string; dist: number }[] = [];
    for (const id in videoPos.current) {
      const { y, h } = videoPos.current[id];
      const cy = (bottomVideoIds.has(id) ? off.bottom : off.top) + y; // → scroll-content coords
      if (cy < bottom && cy + h > top) {
        mountedIds.current.add(id);
        overlapping.push({ id, dist: Math.abs(cy + h / 2 - center) });
      }
    }
    overlapping.sort((a, b) => a.dist - b.dist);
    const next = new Set(overlapping.slice(0, MAX_CONCURRENT_VIDEOS).map(o => o.id));
    setVisibleIds(prev => {
      if (prev.size === next.size && [...next].every(id => prev.has(id))) return prev;
      return next;
    });
  };

  // The masonry layout depends only on the posts and the songTiles mode, not on
  // playback state — so memoize it. Without this the whole filter/sort/group/pack
  // recomputed on every render, including each 250ms audio progress tick.
  const { topCols, bottomCols, bannerPost, playableSet, bottomVideoIds, topShortCol, topPadTop } = useMemo(() => {
    const EMPTY = {
      topCols: [[], []] as Cell[][], bottomCols: [[], []] as Cell[][],
      bannerPost: null as GridPost | null, playableSet: new Set<string>(),
      bottomVideoIds: new Set<string>(), topShortCol: -1, topPadTop: 0,
    };
    if (!posts || posts.length === 0) return EMPTY;

    // Laybell-TV hero banner: the most relevant HORIZONTAL video (posts are already
    // relevance-ordered, so the first landscape one is the top pick). It's featured
    // full-width under the first song card, so exclude it from the grid tiles. Only
    // in the masonry ("All") view — the genre square grid doesn't use it.
    const bannerPost: GridPost | null = songTiles ? null : (posts.find(isHorizontalVideo) ?? null);
    const allVideos = posts.filter(p => p.type === 'video' && p.id !== bannerPost?.id);
    // Spread HORIZONTAL (16:9) tiles evenly among the vertical reels — several
    // landscape clips arriving consecutively would otherwise occupy consecutive
    // video slots and read as a wide-tile cluster on the grid.
    const videos = interleave([
      allVideos.filter(p => !isHorizontalVideo(p)),
      allVideos.filter(isHorizontalVideo),
    ]);
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
      : groupSongs(posts.filter(p => isAudioPost(p.type))).map(g => ({ title: t('explore.trendingSongs'), songs: g }));

    // Which videos auto-play (`playableSet`) is decided AFTER the layout is packed,
    // from each video's final vertical position — not from a content-order slice —
    // so the previews are spread evenly down the whole grid (see below).

    // ── Systematic, declumped masonry ────────────────────────────────────────
    // Three visual VARIETIES share the grid: videos (tall reel tiles), still
    // tiles (image / slideshow), and song stacks. Two independent steps keep the
    // grid a fair, un-clumped mixture no matter the content ratio — instead of
    // the old ad-hoc "music after every 2nd tile + splice videos on alternating
    // sides" heuristic, which could still clump:
    //
    //   1) EVEN INTERLEAVE — deal all three varieties into ONE ordered sequence
    //      with proportional error diffusion (smooth weighted round-robin): each
    //      variety is spread across the whole scroll in proportion to its count,
    //      so a rare type (e.g. one song stack) never bunches and a common type
    //      never dominates a run. Relevance order within each variety is kept.
    //   2) DECLUMPED PACK — masonry into two columns shortest-first, but never
    //      stack the SAME variety back-to-back in a column when the other column
    //      can take it without opening a big height gap. So varieties stay mixed
    //      vertically too, and song stacks in particular never touch.
    const cellFor = (p: GridPost): Cell => ({ kind: 'media', key: p.id, post: p, height: mediaHeight(p) });
    const varietyQueues: Cell[][] = [
      videos.map(cellFor),                                        // videos
      tileMedia.filter(p => p.type !== 'video').map(cellFor),     // still tiles (image/slideshow)
      musicGroups.map((g, i): Cell => ({                          // song stacks
        kind: 'music', key: `music-${i}`, title: g.title, songs: g.songs,
        height: MUSIC_HEADER_H + g.songs.length * ROW_H,
      })),
    ].filter(q => q.length > 0);

    // Deal all three varieties into one evenly-mixed sequence (see interleave).
    const ordered = interleave(varietyQueues);

    // Top-left slot is always a looping preview video: pull the first video to the
    // front so ordered[0] packs into column 0 (top-left) and — being the topmost
    // video — is always autoplay-eligible.
    const firstVideoIdx = ordered.findIndex(c => c.kind === 'media' && c.post.type === 'video');
    if (firstVideoIdx > 0) ordered.unshift(...ordered.splice(firstVideoIdx, 1));
    const heroVideoId = ordered[0]?.kind === 'media' && ordered[0].post.type === 'video' ? ordered[0].post.id : null;

    const variety = (cell: Cell): string =>
      cell.kind === 'music' ? 'music' : cell.post.type === 'video' ? 'video' : 'still';
    const endsWith = (col: Cell[], v: string) =>
      col.length > 0 && variety(col[col.length - 1]) === v;

    // Song cards get deliberate placement: the FIRST on the RIGHT (col 1), each
    // subsequent one on the opposite side from the last (zig-zag), relaxed only if
    // the target column runs much taller. State is carried ACROSS the two sections.
    const music = { seen: false, lastCol: 0 };
    // Pack one section (2-column masonry) and report each video's section-relative
    // center. Non-music cells go shortest-first with same-variety declumping.
    const packSection = (cells: Cell[]) => {
      const cols: Cell[][] = [[], []];
      const colH = [0, 0];
      const centers: { id: string; yc: number }[] = [];
      for (const cell of cells) {
        const v = variety(cell);
        let c: number;
        if (v === 'music') {
          const target = music.seen ? music.lastCol ^ 1 : 1;
          c = colH[target] - colH[target ^ 1] > COL_W * 1.5 ? target ^ 1 : target;
          music.seen = true;
          music.lastCol = c;
        } else {
          c = colH[0] <= colH[1] ? 0 : 1;
          if (endsWith(cols[c], v) && !endsWith(cols[c ^ 1], v) && colH[c ^ 1] - colH[c] <= COL_W) c ^= 1;
        }
        const yTop = colH[c];
        cols[c].push(cell);
        colH[c] += cell.height + GAP;
        if (cell.kind === 'media' && cell.post.type === 'video') centers.push({ id: cell.post.id, yc: yTop + cell.height / 2 });
      }
      return { cols, colH, centers };
    };

    // Split the grid AFTER the first song card and drop the full-width Laybell-TV
    // banner there — so the content BELOW the banner restarts even (a fresh 2-col
    // start). Only when we actually have a banner video and a song card, with room
    // for content on both sides.
    const firstMusicIdx = ordered.findIndex(c => c.kind === 'music');
    const splitAt = bannerPost && firstMusicIdx >= 0 && firstMusicIdx < ordered.length - 1
      ? firstMusicIdx + 1 : -1;
    const rest = splitAt >= 0 ? ordered.slice(splitAt) : [];
    const top = packSection(splitAt >= 0 ? ordered.slice(0, splitAt) : ordered);
    // GAP-FILL / LEVELLING: cutting the section right after the first song card can
    // leave it lopsided (the song card lands on the right, so the left column may
    // hold only the hero) — a blank block sitting on top of the banner. Keep
    // pulling upcoming media tiles into the SHORTER column, BEST-FIT (the tile
    // whose height is closest to the current gap), for as long as it actually
    // shrinks the gap (h < 2·gap). This converges the two columns to nearly flush,
    // so there's never a big hole above the banner — short horizontal 16:9 tiles
    // top off small gaps neatly. A different variety than the landing tile breaks
    // ties (keeps the declumping).
    if (splitAt >= 0) {
      for (;;) {
        const short = top.colH[0] <= top.colH[1] ? 0 : 1;
        const gap = Math.abs(top.colH[0] - top.colH[1]);
        if (gap <= GAP + 2) break; // effectively level
        const lastCell = top.cols[short][top.cols[short].length - 1];
        const lastV = lastCell ? variety(lastCell) : '';
        let bestIdx = -1, bestScore = Infinity;
        for (let k = 0; k < rest.length; k++) {
          const c = rest[k];
          if (c.kind !== 'media' || c.height >= gap * 2) continue; // wouldn't shrink the gap
          const score = Math.abs(c.height - gap) + (variety(c) === lastV ? COL_W * 0.2 : 0);
          if (score < bestScore) { bestScore = score; bestIdx = k; }
        }
        if (bestIdx < 0) break; // nothing left can level it further
        const [cell] = rest.splice(bestIdx, 1) as (Cell & { kind: 'media' })[];
        const yTop = top.colH[short];
        top.cols[short].push(cell);
        top.colH[short] += cell.height + GAP;
        if (cell.post.type === 'video') top.centers.push({ id: cell.post.id, yc: yTop + cell.height / 2 });
      }
    }
    const bottom = packSection(rest);
    const usedBanner = splitAt >= 0 ? bannerPost : null;

    // Global (whole-scroll) video centers so eligibility spacing spans BOTH
    // sections + the banner between them (heights are all computable here).
    const bannerH = usedBanner ? BANNER_H + GAP * 2 : 0;
    const bottomBase = Math.max(top.colH[0], top.colH[1]) + bannerH;

    // Any residual gap the levelling couldn't close sits at the bottom of the
    // shorter top column (under the song card, above the banner). Rather than
    // leave one obvious empty block, CENTER that column's last tile in the leftover
    // space — push it down half the residual, so the space splits above and below
    // it and reads as intentional breathing room, not a hole.
    const topShortCol = usedBanner && top.colH[0] !== top.colH[1] ? (top.colH[0] < top.colH[1] ? 0 : 1) : -1;
    const topResidual = Math.abs(top.colH[0] - top.colH[1]);
    const topPadTop = topShortCol >= 0 && topResidual > GAP * 2 ? Math.round(topResidual / 2) : 0;
    const globalCenters = [
      ...top.centers,
      ...bottom.centers.map(c => ({ id: c.id, yc: c.yc + bottomBase })),
    ].sort((a, b) => a.yc - b.yc);
    const bottomVideoIds = new Set(bottom.centers.map(c => c.id));

    // Autoplay eligibility, spread by POSITION across the whole grid — one preview
    // per ~PLAYABLE_GAP, no clumps, no long gaps. The top-left hero anchors the
    // spacing so a slightly-higher shorter video in the other column can't steal
    // the first preview slot (that made the top-RIGHT play instead of top-left).
    const playableSet = new Set<string>();
    let lastPlayableY = -Infinity;
    if (heroVideoId) {
      const hero = globalCenters.find(v => v.id === heroVideoId);
      if (hero) { playableSet.add(heroVideoId); lastPlayableY = hero.yc; }
    }
    for (const { id, yc } of globalCenters) {
      if (playableSet.has(id)) continue;
      if (yc - lastPlayableY >= PLAYABLE_GAP) { playableSet.add(id); lastPlayableY = yc; }
    }

    return { topCols: top.cols, bottomCols: bottom.cols, bannerPost: usedBanner, playableSet, bottomVideoIds, topShortCol, topPadTop };
  }, [posts, songTiles, songClusters, t]);

  if (!posts || posts.length === 0) {
    return (
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
        refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} /> : undefined}
      >
        {header}
        <View style={styles.empty}><Text style={styles.emptyText}>{emptyText ?? t('exploreGrid.noPosts')}</Text></View>
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
            <AppVideo
              source={{ uri: p.media_url }}
              style={styles.mediaImage}
              contentFit="cover"
              loop
              muted
              active={playing}
              // Muted grid autoplay counts toward views — genuine watch time
              // accumulates app-wide; the server enforces the fairness caps.
              onProgress={(pos, dur) => trackVideoProgress(p.id, pos, dur)}
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
          {/* Genre word on a silvery "plate": a bright sheen up top fading to a
              soft silver, so the pure-white letters read brighter than the card.
              White fill + black outline. */}
          <LinearGradient colors={['#FAFAFA', '#CFCFCF']} style={styles.musicHeader}>
            <View>
              {HEADER_OUTLINE.map(([x, y], i) => (
                <Text
                  key={i}
                  numberOfLines={1}
                  style={[styles.musicHeaderText, styles.musicHeaderStroke, { position: 'absolute', left: x, top: y }]}
                >
                  {cell.title}
                </Text>
              ))}
              <Text style={styles.musicHeaderText} numberOfLines={1}>{cell.title}</Text>
            </View>
          </LinearGradient>
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
                  <Text style={styles.songTitle} numberOfLines={1}>{s.caption || t('explore.audioTrack')}</Text>
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

  // Full-width Laybell-TV hero banner: a big 16:9 thumbnail of the top trending
  // horizontal video, spanning both columns. Sits under the first song card and
  // gives the grid below it a fresh even start. Tap opens the reel. The overlay
  // shows @username (consistent with every other grid tile); the caption sits
  // UNDER the preview as its own line.
  const renderTVBanner = (p: GridPost) => (
    <View style={styles.tvBannerWrap}>
      <TouchableOpacity style={styles.tvBanner} activeOpacity={0.9} onPress={(e: any) => openMedia(p, e)}>
        <VideoThumb thumbnailUrl={p.thumbnail_url} mediaUrl={p.media_url} style={styles.mediaImage} />
        <View style={styles.tvTag}><Ionicons name="tv" size={13} color="#fff" /><Text style={styles.tvTagText}>Laybell TV</Text></View>
        <View style={styles.playBadge}><Ionicons name="play" size={14} color="#fff" /></View>
        <LinearGradient colors={['transparent', 'rgba(0,0,0,0.78)']} style={styles.mediaOverlay}>
          <Text style={styles.mediaUser} numberOfLines={1}>@{p.profiles?.username}</Text>
        </LinearGradient>
        <ThumbStat type={p.type} viewCount={p.view_count} streamCount={p.stream_count} />
      </TouchableOpacity>
      {!!p.caption && <TVCaption text={p.caption} />}
    </View>
  );

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
            <Text style={styles.squareTitleText} numberOfLines={1}>{p.caption || t('explore.audioTrack')}</Text>
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
      contentContainerStyle={[styles.scroll, bottomPad ? { paddingBottom: bottomPad } : null]}
      // 16 is deliberate: the chrome is discrete (state picks + native glides),
      // so nothing needs per-frame JS scroll events (see feedChrome).
      scrollEventThrottle={16}
      onScroll={e => {
        scrollY.current = e.nativeEvent.contentOffset.y;
        recomputeActive();
        if (trackChrome) trackFeedScroll(e.nativeEvent.contentOffset.y, e.nativeEvent.contentSize.height - e.nativeEvent.layoutMeasurement.height);
      }}
      onScrollBeginDrag={trackChrome ? feedDragStart : undefined}
      onScrollEndDrag={trackChrome ? feedDragEnd : undefined}
      onMomentumScrollEnd={trackChrome ? settleFeedChrome : undefined}
      onLayout={e => { viewportH.current = e.nativeEvent.layout.height; recomputeActive(); }}
      refreshControl={
        onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} /> : undefined
      }
    >
      {header}
      {songTiles ? (
        <View style={styles.grid3}>{posts.map(renderSquare)}</View>
      ) : (
        <>
          <View
            style={styles.row}
            onLayout={e => { sectionOffsets.current.top = e.nativeEvent.layout.y; recomputeActive(); }}
          >
            {topCols.map((col, ci) => (
              <View key={ci} style={styles.col}>
                {col.map((cell, ri) =>
                  // Center the shorter column's last tile in the leftover space so
                  // a residual gap under the song card splits above/below it.
                  ci === topShortCol && ri === col.length - 1 && topPadTop > 0
                    ? <View key={cell.key} style={{ marginTop: topPadTop }}>{renderCell(cell)}</View>
                    : renderCell(cell)
                )}
              </View>
            ))}
          </View>
          {bannerPost && renderTVBanner(bannerPost)}
          {(bottomCols[0].length > 0 || bottomCols[1].length > 0) && (
            <View
              style={styles.row}
              onLayout={e => { sectionOffsets.current.bottom = e.nativeEvent.layout.y; recomputeActive(); }}
            >
              {bottomCols.map((col, ci) => (
                <View key={ci} style={styles.col}>{col.map(renderCell)}</View>
              ))}
            </View>
          )}
        </>
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

  // Full-width Laybell-TV hero banner (spans both columns; content below restarts even).
  tvBannerWrap: { marginVertical: GAP },
  tvBanner: {
    height: BANNER_H, borderRadius: RADIUS.md, overflow: 'hidden',
    backgroundColor: colors.surfaceLight, position: 'relative',
  },
  // Same face as the caption under real Laybell-TV thumbnails (components/
  // TVVideoList.tsx `caption`: text color, weight 700) — just bigger for the hero.
  tvCaption: { color: colors.text, fontSize: 15, fontWeight: '700', lineHeight: 20, marginTop: 6, paddingHorizontal: 2 },
  // One-line captions only (see TVCaption): slightly larger, and EQUAL space above
  // and below so the single line sits evenly centered in its area (overrides the
  // base marginTop). Multi-line captions keep the base style untouched.
  tvCaptionBig: { fontSize: 17, lineHeight: 22, marginTop: 9, marginBottom: 9 },
  tvTag: {
    position: 'absolute', top: 8, right: 8, flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: RADIUS.full, paddingHorizontal: 8, paddingVertical: 3,
  },
  tvTagText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.3 },
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
  },
  // Pure-white word on the silver plate: the black outline copies (see
  // HEADER_OUTLINE) crisp the edges, and a soft dark shadow lifts the letters off
  // the card for a raised/embossed look — so background-white and text-white read
  // as clearly different surfaces, not one flat block.
  musicHeaderText: {
    color: '#FFFFFF', fontSize: 14, fontWeight: '900', fontStyle: 'italic',
    textTransform: 'uppercase', letterSpacing: 1.6,
    textShadowColor: 'rgba(0,0,0,0.3)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3,
  },
  // Black outline copies stacked behind the white fill (see HEADER_OUTLINE).
  // Kill the fill's shadow here so only the top white copy is shadowed (8 shadowed
  // black copies would smear into a muddy halo).
  musicHeaderStroke: { color: '#000', textShadowColor: 'transparent', textShadowRadius: 0 },
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
