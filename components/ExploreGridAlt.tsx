import { useEffect, useState, type ReactNode } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Dimensions, RefreshControl,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { useNowPlaying } from '../contexts/AudioContext';
import { usePostOptions } from '../contexts/PostOptionsContext';
import { isSwipeTap } from '../contexts/PagerContext';
import { isAudioPost } from '../lib/genres';
import { isHorizontalVideo } from '../lib/tv';
import { isSlideshow, slideshowThumb } from '../lib/slideshow';
import { cfStreamThumbnail } from '../lib/cast';
import { previewImageProps } from '../lib/mediaPreview';
import { feedDragEnd, feedDragStart, settleFeedChrome, trackFeedScroll } from '../lib/feedChrome';
import VideoThumb from './VideoThumb';
import ThumbStat from './ThumbStat';
import { Marquee } from './SongCardTitle';
import PreviewStills from './PreviewStills';

// Two ALTERNATE Explore layouts the user can flip to from the header switcher
// (components/ExploreGrid is the default "mosaic"):
//   • variant='minimal' — an airy 2-column, rounded, whitespace-forward grid with a
//     clean Laybell-TV hero up top and song tiles that caption BELOW the art. Calm.
//   • variant='grid3'   — an EDITORIAL feed of composed blocks: a cinematic hero,
//     a wide Laybell-TV strip, QUAD blocks (four squares beside a tall vertical
//     reel, reel side flipping each time), and occasional 3-up square rows, with
//     horizontal song RAILS threaded between them. Sharp corners, no 2-wide tiles;
//     songs stay mixed in, never piled at the bottom.
// Both are Laybell-aware: songs, horizontal Laybell-TV videos, vertical reels, photos
// and slideshows each get their own treatment. STATIC thumbnails for now (no live
// video previews) — this is a layout exploration; motion can be wired in once a
// direction is chosen.

type GridPost = {
  id: string; type: string; media_url: string; caption: string;
  thumbnail_url?: string | null; thumb_url?: string | null; placeholder?: string | null;
  aspect_ratio?: string | null; cover_url?: string | null; slides?: any;
  stream_count?: number; view_count?: number; user_id?: string;
  preview_url?: string | null; duration_seconds?: number | null;
  trim_start?: number | null; trim_end?: number | null;
  profiles?: { username: string; display_name: string } | null;
};
type SongCluster = { title: string; songs: GridPost[] };

const W = Dimensions.get('window').width;

// Minimal: 2 columns, generous gap, big radius — airy and editorial.
const MIN_PAD = SPACING.md;
const MIN_GAP = 12;
const MIN_COL = (W - MIN_PAD * 2 - MIN_GAP) / 2;

// Grid3: 3 columns, tight gaps — a typed mosaic (tile shape follows content type).
const G3_PAD = 1;
const G3_GAP = 1;
const G3_COL = (W - G3_PAD * 2 - G3_GAP * 2) / 3;
// Editorial block heights — all derived from the 3-col width so they scale per device.
const G3_FULLW = W - G3_PAD * 2;                    // full content width (one row of 3 + gaps)
const G3_HERO_H = Math.round(G3_FULLW * 0.56);      // cinematic opener (~1.8:1)
const G3_SPOT_H = Math.round(G3_COL * 2 + G3_GAP);  // 2×2 feature = two stacked squares tall
const G3_TV_H = Math.round(G3_FULLW * 0.42);        // wide Laybell-TV strip (~2.4:1)
const G3_SINGLE_H = Math.round(G3_COL * 0.94);      // short full-width strip for a lone remainder
const G3_SQ_H = Math.round(G3_COL);                 // a 1:1 square tile
const G3_RAIL_SONGS = 24;                           // max cards in a horizontal song rail (scrollable)
const G3_QUAD_REEL_FLEX = 1.3;                      // reel column wider than one square (grid is flex 2) → truer 9:16 reel; squares go slightly portrait to match
const G3_SC_ROWS = 4;                               // song rows shown in the sound-card menu (what fits the reel-sized tile)

// Pull up to `cap` songs out of the clusters, round-robin across them (one each,
// then seconds, …) so the mix stays varied instead of front-loading one genre.
function flattenSongs(clusters: SongCluster[] | undefined, fallback: GridPost[], cap: number): GridPost[] {
  if (!clusters || clusters.length === 0) return fallback.slice(0, cap);
  const out: GridPost[] = [];
  for (let i = 0; out.length < cap; i++) {
    let any = false;
    for (const c of clusters) {
      if (c.songs[i]) { out.push(c.songs[i]); any = true; if (out.length >= cap) break; }
    }
    if (!any) break;
  }
  return out;
}

// Even weighted round-robin (error diffusion): deal queues into one sequence, each
// spread across it in proportion to its size — so songs and posts stay interleaved
// instead of clumping. Same idea as ExploreGrid's interleave.
function interleave<T>(queues: T[][]): T[] {
  const live = queues.filter(q => q.length > 0);
  const total = live.reduce((n, q) => n + q.length, 0);
  const st = live.map(q => ({ q, i: 0, credit: 0 }));
  const out: T[] = [];
  for (let step = 0; step < total; step++) {
    let pick: (typeof st)[number] | null = null;
    for (const x of st) {
      if (x.i >= x.q.length) continue;
      x.credit += x.q.length;
      if (!pick || x.credit > pick.credit) pick = x;
    }
    if (!pick) break;
    pick.credit -= total;
    out.push(pick.q[pick.i++]);
  }
  return out;
}

export default function ExploreGridAlt({
  posts, songClusters, songTiles, variant, currentUserId, onRefresh, refreshing,
  bottomPad, header, onClusterSongPlay, onPostDeleted, trackChrome,
}: {
  posts: GridPost[];
  songClusters?: SongCluster[];
  songTiles?: boolean;
  variant: 'minimal' | 'grid3';
  currentUserId?: string | null;
  onRefresh?: () => void; refreshing?: boolean;
  bottomPad?: number; header?: ReactNode;
  onClusterSongPlay?: () => void;
  onPostDeleted?: (id: string) => void;
  trackChrome?: boolean;
}) {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { play: playRaw, id: playingTrackId, playing: isPlaying } = useNowPlaying();
  const { show: showOptions } = usePostOptions();

  const playSong = (s: GridPost) => {
    if (isSwipeTap()) return;
    playRaw({ id: s.id, uri: s.media_url, caption: s.caption, artist: s.profiles?.display_name ?? '', cover: s.cover_url });
    if (isAudioPost(s.type)) onClusterSongPlay?.();
  };
  const openMedia = (p: GridPost) => {
    if (isSwipeTap()) return;
    const pathname = p.type === 'video' ? '/reel/[id]' : '/post/[id]';
    router.push({ pathname, params: { id: p.id, post: JSON.stringify(p) } });
  };
  const longPressFor = (p: GridPost) =>
    currentUserId
      ? () => showOptions({
          postId: p.id, isOwn: p.user_id === currentUserId, authorId: p.user_id,
          authorName: p.profiles?.username, mediaType: p.type, aspect: p.aspect_ratio,
          caption: p.caption, thumbnail: p.thumbnail_url,
          onEdit: () => router.push(`/edit-post/${p.id}`),
          onDeleted: () => onPostDeleted?.(p.id),
          onArchived: () => onPostDeleted?.(p.id),
          onBlocked: () => onPostDeleted?.(p.id),
        })
      : undefined;

  // One-shot ~10s preview of the FIRST Laybell-TV video: the thumbnail shows, then
  // a beat later its small CACHED preview clip plays for ~10s, then the thumbnail
  // returns. Cost-safe — the tile uses PreviewStills, which plays the immutable
  // preview_url clip via expo-video caching (one tiny download per phone), never the
  // billed HLS stream; a post without a clip just stays on its thumbnail.
  const [heroPlay, setHeroPlay] = useState(false);
  // A stable per-mount offset that rotates the song categories, so the leading song card
  // isn't always "Trending" — it mixes up which category comes first each time Explore mounts.
  const [railRot] = useState(() => Math.floor(Math.random() * 997));
  useEffect(() => {
    const on = setTimeout(() => setHeroPlay(true), 900);
    const off = setTimeout(() => setHeroPlay(false), 10900);
    return () => { clearTimeout(on); clearTimeout(off); };
  }, []);

  // ── Build the content streams ──────────────────────────────────────────────
  // Media = everything that isn't audio; the top horizontal video becomes the
  // Laybell-TV hero. Audio is kept apart: grid3 groups it into song TABLES, while
  // minimal threads individual song tiles through an evenly-mixed stream.
  const media = posts.filter(p => !isAudioPost(p.type));
  const tvHero = media.find(isHorizontalVideo) ?? null;
  const mediaRest = tvHero ? media.filter(p => p.id !== tvHero.id) : media;
  const audio = posts.filter(p => isAudioPost(p.type));
  // Minimal-only: one evenly-mixed stream of media + individual song tiles.
  const songsForMin = flattenSongs(songClusters, audio, songTiles ? 24 : 14);
  const items = interleave([mediaRest, songsForMin]);

  const empty = !posts || posts.length === 0;

  const scrollProps = {
    showsVerticalScrollIndicator: false,
    keyboardShouldPersistTaps: 'handled' as const,
    scrollEventThrottle: 16,
    onScroll: trackChrome ? (e: any) => trackFeedScroll(
      e.nativeEvent.contentOffset.y,
      e.nativeEvent.contentSize.height - e.nativeEvent.layoutMeasurement.height,
    ) : undefined,
    onScrollBeginDrag: trackChrome ? feedDragStart : undefined,
    onScrollEndDrag: trackChrome ? feedDragEnd : undefined,
    onMomentumScrollEnd: trackChrome ? settleFeedChrome : undefined,
    refreshControl: onRefresh
      ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} />
      : undefined,
  };

  // ── Shared tile bodies ─────────────────────────────────────────────────────
  // A media tile's inner content (image/video thumb + badges). The parent tile sets
  // the size; this fills it.
  const mediaBody = (p: GridPost, showUser: boolean) => {
    const horizontal = isHorizontalVideo(p);
    return (
      <>
        {p.type === 'video' ? (
          <VideoThumb
            thumbnailUrl={p.thumb_url || p.thumbnail_url || cfStreamThumbnail(p.media_url)}
            placeholder={p.placeholder}
            mediaUrl={p.media_url}
            style={styles.fill}
          />
        ) : isSlideshow(p.type) ? (
          <ExpoImage source={{ uri: p.thumb_url || slideshowThumb(p) || p.media_url }} style={styles.fill} contentFit="cover" cachePolicy="memory-disk" recyclingKey={p.id} {...previewImageProps(p)} />
        ) : (
          <ExpoImage source={{ uri: p.thumb_url || p.media_url }} style={styles.fill} contentFit="cover" cachePolicy="memory-disk" recyclingKey={p.id} {...previewImageProps(p)} />
        )}
        {p.type === 'video' && (
          <View style={styles.badge}>
            <Ionicons name={horizontal ? 'tv' : 'play'} size={11} color="#fff" />
          </View>
        )}
        {isSlideshow(p.type) && <View style={styles.badge}><Ionicons name="copy" size={11} color="#fff" /></View>}
        {p.type === 'video' && <ThumbStat type={p.type} viewCount={p.view_count} streamCount={p.stream_count} />}
        {showUser && !!p.profiles?.username && (
          <LinearGradient colors={['transparent', 'rgba(0,0,0,0.6)']} style={styles.userScrim}>
            <Text style={styles.userText} numberOfLines={1}>@{p.profiles?.username}</Text>
          </LinearGradient>
        )}
      </>
    );
  };

  // A square song tile: album art + play badge + a title bar along the bottom.
  const songBody = (s: GridPost, showTitle = true) => {
    const active = playingTrackId === s.id && isPlaying;
    return (
      <>
        {s.cover_url ? (
          <ExpoImage source={{ uri: s.thumb_url || s.cover_url }} style={styles.fill} contentFit="cover" cachePolicy="memory-disk" recyclingKey={s.id} {...previewImageProps(s)} />
        ) : (
          <LinearGradient colors={GRADIENTS.primarySoft} style={[styles.fill, styles.center]}>
            <Ionicons name="musical-notes" size={24} color={colors.primary} />
          </LinearGradient>
        )}
        <View style={styles.badge}><Ionicons name={active ? 'pause' : 'musical-notes'} size={11} color="#fff" /></View>
        {showTitle && (
          <View style={styles.songBar}>
            <Text style={styles.songBarText} numberOfLines={1}>{s.caption || `@${s.profiles?.username}`}</Text>
          </View>
        )}
      </>
    );
  };

  // The Laybell-TV overlay chrome (tag + stat + watch chip), reused by the static
  // thumbnail body and by the hero's live preview tile.
  const tvOverlays = (p: GridPost) => (
    <>
      <View style={styles.tvTag}><Ionicons name="tv" size={12} color="#fff" /><Text style={styles.tvTagText}>Laybell TV</Text></View>
      <ThumbStat type={p.type} viewCount={p.view_count} streamCount={p.stream_count} />
      <LinearGradient colors={['transparent', 'rgba(0,0,0,0.72)']} style={styles.tvScrim}>
        <View style={styles.watchChip}><Ionicons name="play" size={11} color="#000" /><Text style={styles.watchText}>{t('a11y.play')}</Text></View>
      </LinearGradient>
    </>
  );
  // The Laybell-TV hero/feature inner content (16:9): static thumbnail + chrome.
  const tvBody = (p: GridPost) => (
    <>
      <VideoThumb thumbnailUrl={p.thumb_url || p.thumbnail_url || cfStreamThumbnail(p.media_url)} placeholder={p.placeholder} mediaUrl={p.media_url} style={styles.fill} />
      {tvOverlays(p)}
    </>
  );

  // ── MINIMAL: airy 2-column masonry ─────────────────────────────────────────
  if (variant === 'minimal') {
    // Height of each tile so the shortest-column pack stays balanced.
    const heightOf = (it: GridPost): number => {
      if (isAudioPost(it.type)) return MIN_COL + 34;                 // art + title below
      if (it.type === 'video') return isHorizontalVideo(it) ? Math.round(MIN_COL * 9 / 16) : Math.round(MIN_COL * 1.3);
      return MIN_COL;                                                // photos / slideshows 1:1
    };
    const cols: GridPost[][] = [[], []];
    const colH = [0, 0];
    for (const it of items) {
      const c = colH[0] <= colH[1] ? 0 : 1;
      cols[c].push(it);
      colH[c] += heightOf(it) + MIN_GAP;
    }
    const tile = (it: GridPost) => {
      const h = heightOf(it);
      if (isAudioPost(it.type)) {
        // Calm song tile: square art, caption + artist BELOW it (editorial).
        return (
          <TouchableOpacity key={it.id} activeOpacity={0.85} onPress={() => playSong(it)} onLongPress={longPressFor(it)} style={styles.minSong}>
            <View style={[styles.minArt, { height: MIN_COL }]}>{songBody(it)}</View>
            <Text style={styles.minSongTitle} numberOfLines={1}>{it.caption || t('explore.audioTrack')}</Text>
            <Text style={styles.minSongArtist} numberOfLines={1}>@{it.profiles?.username}</Text>
          </TouchableOpacity>
        );
      }
      return (
        <TouchableOpacity key={it.id} activeOpacity={0.9} onPress={() => openMedia(it)} onLongPress={longPressFor(it)} style={[styles.minTile, { height: h }]}>
          {mediaBody(it, false)}
        </TouchableOpacity>
      );
    };
    return (
      <ScrollView {...scrollProps} contentContainerStyle={[styles.minScroll, bottomPad ? { paddingBottom: bottomPad } : null]}>
        {header}
        {tvHero && (
          <TouchableOpacity activeOpacity={0.9} onPress={() => openMedia(tvHero)} style={styles.minHero}>
            {tvBody(tvHero)}
          </TouchableOpacity>
        )}
        {!!tvHero?.caption && <Text style={styles.minHeroCaption} numberOfLines={2}>{tvHero.caption}</Text>}
        {empty ? (
          <View style={styles.empty}><Text style={styles.emptyText}>{t('exploreGrid.noPosts')}</Text></View>
        ) : (
          <View style={styles.minRow}>
            {cols.map((col, ci) => (
              <View key={ci} style={styles.minCol}>{col.map(tile)}</View>
            ))}
          </View>
        )}
      </ScrollView>
    );
  }

  // ── GRID3: an EDITORIAL mixed-span feed ────────────────────────────────────
  // Not a uniform grid — a sequence of COMPOSED blocks whose tiles deliberately
  // differ in width and height: a cinematic hero, a wide Laybell-TV strip, a QUAD
  // block (four square posts beside one tall vertical reel, reel side flipping each
  // time), and 3-up rows of squares (an occasional "rest" that also soaks up the
  // leftovers at the very bottom). Horizontal song RAILS are threaded between the
  // visual blocks so music stays mixed in. No 2-wide tiles; corners stay sharp.
  // Song RAILS. A single "Trending songs" rail always LEADS (never a bare genre name
  // like "rap"); in All view the genre clusters follow it, each its own scrollable
  // rail. In genre view there is just the one long Trending rail.
  const trendingRail: SongCluster[] = audio.length ? [{ title: t('explore.trendingSongs'), songs: audio }] : [];
  const rawTables: SongCluster[] = songClusters && songClusters.length > 0
    ? [...trendingRail, ...songClusters]
    : trendingRail;
  // One song, one rail: a later category drops any song already shown above (the Trending rail
  // and the genre rails overlap, which reads as repetitive). Keep a rail only if ≥2 cards survive
  // — a lone card looks bare, and this also thins out genre rows that were mostly repeats.
  const seenSongIds = new Set<string>();
  const tables: SongCluster[] = [];
  for (const c of rawTables) {
    const songs = c.songs.filter(s => !seenSongIds.has(s.id));
    if (songs.length < 2) continue;
    for (const s of songs) seenSongIds.add(s.id);
    tables.push({ ...c, songs });
  }

  // Content queues. Horizontal videos are reserved for the wide slots (hero / TV).
  // Vertical reels feed the tall "vertical reel" slot in each quad; photos and
  // slideshows (plus any spare reels) fill the square slots. nextSquare() alternates
  // stills/reels so square rows stay mixed; nextTall() prefers a real reel.
  const horizontals = media.filter(isHorizontalVideo);
  const reels = media.filter(p => p.type === 'video' && !isHorizontalVideo(p));
  // The hero prefers a horizontal clip that HAS a cached preview, so the first Laybell-TV
  // video can show its ~10s preview. Every OTHER horizontal joins the square pool as an
  // ordinary tile — the hero is the ONLY full-width Laybell-TV block anywhere, so there is
  // never a stray half-and-half TV strip in the body or at the bottom (owner 2026-11-12).
  const heroTv = horizontals.find(p => !!p.preview_url) ?? horizontals[0];
  const stills = [
    ...media.filter(p => p.type !== 'video'),
    ...horizontals.filter(p => p.id !== heroTv?.id),
  ];
  // Rotate the category order by the stable per-mount offset so a different category leads
  // the song cards each visit instead of always Trending (owner: mix it up).
  const railStart = tables.length ? railRot % tables.length : 0;
  const rails = [...tables.slice(railStart), ...tables.slice(0, railStart)];
  const left = () => reels.length + stills.length;
  let sqTog = 0;
  const nextSquare = (): GridPost | undefined =>
    sqTog++ % 2 === 0 ? (stills.shift() ?? reels.shift()) : (reels.shift() ?? stills.shift());
  const nextTall = (): GridPost | undefined => reels.shift() ?? stills.shift();

  type Block =
    | { k: 'hero'; p: GridPost }
    | { k: 'tv'; p: GridPost }
    | { k: 'single'; p: GridPost }
    | { k: 'quad'; side: 'L' | 'R'; preview: boolean; tall: GridPost; q: GridPost[] }
    | { k: 'triple'; a: GridPost; b: GridPost; c: GridPost }
    | { k: 'duo'; a: GridPost; b: GridPost }
    | { k: 'rail'; g: SongCluster }
    | { k: 'songquad'; side: 'L' | 'R'; title: string; songs: GridPost[]; q: GridPost[] }
    | { k: 'trio'; items: GridPost[] };

  const blocks: Block[] = [];
  // Never two song rows back to back: a rail pushed right after another rail merges into it
  // (deduped) and takes a generic title, so leftovers become ONE longer scrollable section
  // instead of a stack of separate rows.
  const pushRailBlock = (g: SongCluster) => {
    const last = blocks[blocks.length - 1];
    if (last && last.k === 'rail') {
      const seen = new Set(last.g.songs.map((s) => s.id));
      last.g = { title: t('music.moreYouLike'), songs: [...last.g.songs, ...g.songs.filter((s) => !seen.has(s.id))] };
    } else {
      blocks.push({ k: 'rail', g });
    }
  };
  // Each category renders as a tall "sound-card menu" (songquad: the category on the LEFT,
  // reel-sized, flanked by four 1×1 posts) when there are ≥4 squares to flank it; with fewer
  // squares it falls back to a horizontal song rail.
  const pushCategory = (side: 'L' | 'R') => {
    const g = rails.shift();
    if (!g) return;
    if (g.songs.length && left() >= 4) {
      const q = [nextSquare()!, nextSquare()!, nextSquare()!, nextSquare()!];
      const shown = g.songs.slice(0, G3_SC_ROWS);
      blocks.push({ k: 'songquad', side, title: g.title, songs: shown, q });
      // Songs past the card's 4 weren't chosen here, so keep them eligible: requeue the rest
      // to surface later (a bottom song row, or another card) instead of being dropped.
      const rest = g.songs.slice(G3_SC_ROWS);
      if (rest.length >= 2) rails.push({ ...g, songs: rest });
    } else {
      pushRailBlock(g);
    }
  };

  // Cinematic opener: a horizontal Laybell-TV clip if we have one, else the first
  // visual.
  const heroPost = heroTv ?? nextTall() ?? nextSquare();
  if (heroPost) blocks.push({ k: 'hero', p: heroPost });

  // Repeating format, mirroring the top: quad (four squares + a tall vertical reel) → a 3-up
  // square row → a sound-card menu (songquad) → a 3-up square row, then loops. The hero is
  // the one full-width Laybell-TV block; there are NO TV strips in this cycle. The reel side
  // flips each quad so the rhythm never repeats.
  // Each section flips the tall elements: within a section the quad's reel and the sound
  // card sit on OPPOSITE sides, and both switch over for the next section — a zigzag.
  let side: 'L' | 'R' = 'R';   // first section: reel RIGHT, card LEFT
  let quadCount = 0;
  let guard = 0;
  while (left() >= 5 && guard++ < 500) {
    const reelSide = side;
    const cardSide: 'L' | 'R' = reelSide === 'R' ? 'L' : 'R';
    const tall = nextTall()!;
    const q = [nextSquare()!, nextSquare()!, nextSquare()!, nextSquare()!];
    // Only the first couple of reels actually play their preview — PreviewStills warns a
    // screen should never be "a screen of players"; the rest hold their poster.
    blocks.push({ k: 'quad', side: reelSide, preview: quadCount < 2, tall, q });
    quadCount++;
    // 3-up square row directly under the quad.
    if (left() >= 3) blocks.push({ k: 'triple', a: nextSquare()!, b: nextSquare()!, c: nextSquare()! });
    // Sound-card menu (next category) on the side opposite the reel, flanked by 1×1 posts.
    pushCategory(cardSide);
    // 3-up square row directly under the sound card.
    if (left() >= 3) blocks.push({ k: 'triple', a: nextSquare()!, b: nextSquare()!, c: nextSquare()! });
    side = side === 'R' ? 'L' : 'R';   // next section flips both
  }

  // Tail — full 3-up rows of 1×1s first.
  while (left() >= 3) {
    blocks.push({ k: 'triple', a: nextSquare()!, b: nextSquare()!, c: nextSquare()! });
  }
  // A 1- or 2-square remainder must NEVER become a half-and-half 2-wide (or lone-wide) row.
  // Borrow songs from the leftover categories to complete it to a clean 3-up of 1×1 tiles
  // (owner 2026-11-12: take a song from a category row to be the 3rd post). Borrowed songs
  // are dropped from the song rows below so nothing shows twice; with no songs to borrow the
  // stragglers still render as fixed 1:1 tiles — never stretched to half width.
  const borrowed = new Set<string>();
  const borrowPool = rails.flatMap(c => c.songs);
  let borrowIdx = 0;
  const borrowSong = (): GridPost | undefined => {
    while (borrowIdx < borrowPool.length) {
      const s = borrowPool[borrowIdx++];
      if (s && !borrowed.has(s.id)) { borrowed.add(s.id); return s; }
    }
    return undefined;
  };
  if (left() > 0) {
    const items: GridPost[] = [];
    while (left() > 0) items.push(nextSquare()!);
    for (let s = borrowSong(); s && items.length < 3; s = borrowSong()) items.push(s);
    blocks.push({ k: 'trio', items });
  }
  // Leftover categories as horizontal song rows (minus anything borrowed above).
  for (let rg = rails.shift(); rg; rg = rails.shift()) {
    const songs = rg.songs.filter(s => !borrowed.has(s.id));
    if (songs.length) pushRailBlock({ ...rg, songs });
  }

  // ── Block renderers ────────────────────────────────────────────────────────
  // One square/feature media tile. `style` carries the slot sizing (flex / height).
  const cell = (p: GridPost, showUser: boolean, style?: any) => (
    <TouchableOpacity key={p.id} activeOpacity={0.9} onPress={() => openMedia(p)} onLongPress={longPressFor(p)} style={[styles.g3Cell, style]}>
      {mediaBody(p, showUser)}
    </TouchableOpacity>
  );
  // A full-width tile (hero / TV strip / lone remainder). Horizontal videos get the
  // Laybell-TV treatment; anything else fills the wide slot with a cover crop.
  const wide = (p: GridPost, h: number, key: string) => (
    <TouchableOpacity key={key} activeOpacity={0.92} onPress={() => openMedia(p)} onLongPress={longPressFor(p)} style={[styles.g3Cell, styles.g3Block, { height: h }]}>
      {isHorizontalVideo(p) ? tvBody(p) : mediaBody(p, true)}
    </TouchableOpacity>
  );

  // The quad's tall reel: plays the cached video preview (cost-safe — the immutable
  // preview_url MP4, never Cloudflare HLS), falling back to the unbilled still-frame
  // slideshow when the clip is missing or won't load. Only `preview` reels move.
  const reelTile = (p: GridPost, preview: boolean, style?: any) => {
    if (preview && p.type === 'video') {
      return (
        <TouchableOpacity key={p.id} activeOpacity={0.9} onPress={() => openMedia(p)} onLongPress={longPressFor(p)} style={[styles.g3Cell, style]}>
          <PreviewStills
            uri={p.media_url}
            previewUrl={p.preview_url}
            thumbnailUrl={p.thumb_url || p.thumbnail_url || cfStreamThumbnail(p.media_url)}
            placeholder={p.placeholder}
            durationSec={p.duration_seconds}
            trimStartSec={p.trim_start}
            trimEndSec={p.trim_end}
            play
            contentFit="cover"
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.badge}><Ionicons name="play" size={11} color="#fff" /></View>
        </TouchableOpacity>
      );
    }
    return cell(p, false, style);
  };
  // A song as a 1:1 tile (album art + play badge + title bar) — used to complete a short
  // bottom row so it stays a full 3-up of squares instead of a half-and-half 2-wide.
  const songCell = (s: GridPost, style?: any) => (
    <TouchableOpacity key={s.id} activeOpacity={0.9} onPress={() => playSong(s)} onLongPress={longPressFor(s)} style={[styles.g3Cell, style]}>
      {songBody(s, false)}
    </TouchableOpacity>
  );

  // Horizontal song RAIL: a titled strip of album-art cards that scrolls sideways.
  const railCard = (s: GridPost) => {
    const active = playingTrackId === s.id && isPlaying;
    return (
      <TouchableOpacity key={s.id} activeOpacity={0.85} onPress={() => playSong(s)} onLongPress={longPressFor(s)} style={styles.g3RailCard}>
        <View style={styles.g3RailArt}>
          {s.cover_url ? (
            <ExpoImage source={{ uri: s.thumb_url || s.cover_url }} style={styles.fill} contentFit="cover" cachePolicy="memory-disk" recyclingKey={s.id} {...previewImageProps(s)} />
          ) : (
            <LinearGradient colors={active ? GRADIENTS.primary : GRADIENTS.primarySoft} style={[styles.fill, styles.center]}>
              <Ionicons name="musical-notes" size={20} color={active ? '#fff' : colors.primary} />
            </LinearGradient>
          )}
        </View>
        <Marquee seamless><Text style={styles.g3RailCardTitle}>{s.caption || t('explore.audioTrack')}</Text></Marquee>
        <Text style={styles.g3RailCardArtist} numberOfLines={1}>@{s.profiles?.username}</Text>
      </TouchableOpacity>
    );
  };
  const railBlock = (g: SongCluster) => (
    <View key={`rail-${g.songs[0]?.id ?? g.title}`} style={styles.g3Rail}>
      <View style={styles.g3RailHead}>
        <Text style={styles.g3RailHeadText} numberOfLines={1}>{g.title}</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.g3RailRow}>
        {g.songs.slice(0, G3_RAIL_SONGS).map(railCard)}
      </ScrollView>
    </View>
  );

  // A tall "sound card" sized like the quad's reel: a TITLED MENU of songs — cover + title +
  // artist per row, tap to play, echoing Laybell's song list — not a single track. Used in
  // the songquad block (the slot the Trending rail used to occupy), on the LEFT.
  const soundCard = (title: string, songs: GridPost[]) => (
    <View key="sc" style={[styles.g3Cell, styles.g3ScCard, { flex: G3_QUAD_REEL_FLEX }]}>
      <View style={styles.g3ScHead}>
        <Text style={styles.g3ScHeadText} numberOfLines={1}>{title}</Text>
      </View>
      <View style={styles.g3ScList}>
        {songs.slice(0, G3_SC_ROWS).map((s, idx, arr) => {
          const active = playingTrackId === s.id && isPlaying;
          const art = s.thumb_url || s.cover_url;
          return (
            <TouchableOpacity key={s.id} activeOpacity={0.8} onPress={() => playSong(s)} onLongPress={longPressFor(s)} style={[styles.g3ScRow, idx < arr.length - 1 && styles.g3ScRowDivider, active && styles.g3ScRowActive]}>
              <View style={styles.g3ScArt}>
                {art ? (
                  <ExpoImage source={{ uri: art }} style={styles.fill} contentFit="cover" cachePolicy="memory-disk" recyclingKey={s.id} {...previewImageProps(s)} />
                ) : (
                  <LinearGradient colors={GRADIENTS.primarySoft} style={[styles.fill, styles.center]}>
                    <Ionicons name="musical-notes" size={13} color={colors.primary} />
                  </LinearGradient>
                )}
                {active && <View style={styles.g3ScArtActive}><Ionicons name="volume-medium" size={11} color="#fff" /></View>}
              </View>
              <View style={styles.g3ScRowText}>
                <Marquee seamless><Text style={styles.g3ScRowTitle}>{s.caption || t('explore.audioTrack')}</Text></Marquee>
                <Text style={styles.g3ScRowArtist} numberOfLines={1}>@{s.profiles?.username}</Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );

  const renderBlock = (blk: Block): ReactNode => {
    switch (blk.k) {
      case 'hero': {
        const p = blk.p;
        // The first Laybell-TV video: thumbnail → ~10s cached preview → thumbnail.
        if (isHorizontalVideo(p) && p.preview_url) {
          return (
            <TouchableOpacity key={`hero-${p.id}`} activeOpacity={0.92} onPress={() => openMedia(p)} onLongPress={longPressFor(p)} style={[styles.g3Cell, styles.g3Block, { height: G3_HERO_H }]}>
              <PreviewStills
                uri={p.media_url}
                previewUrl={p.preview_url}
                thumbnailUrl={p.thumb_url || p.thumbnail_url || cfStreamThumbnail(p.media_url)}
                placeholder={p.placeholder}
                durationSec={p.duration_seconds}
                trimStartSec={p.trim_start}
                trimEndSec={p.trim_end}
                play={heroPlay}
                contentFit="cover"
                style={StyleSheet.absoluteFill}
              />
              {tvOverlays(p)}
            </TouchableOpacity>
          );
        }
        return wide(p, G3_HERO_H, `hero-${p.id}`);
      }
      case 'tv': return wide(blk.p, G3_TV_H, `tv-${blk.p.id}`);
      case 'single': return (
        <TouchableOpacity key={`single-${blk.p.id}`} activeOpacity={0.92} onPress={() => openMedia(blk.p)} onLongPress={longPressFor(blk.p)} style={[styles.g3Cell, styles.g3Block, { height: G3_SINGLE_H }]}>
          {mediaBody(blk.p, true)}
        </TouchableOpacity>
      );
      case 'quad': {
        const grid = (
          <View key="q" style={styles.g3QuadGrid}>
            <View style={[styles.g3RowFlex, styles.g3QuadRow]}>
              {cell(blk.q[0], false, { flex: 1 })}
              {cell(blk.q[1], false, { flex: 1 })}
            </View>
            <View style={[styles.g3RowFlex, styles.g3QuadRow]}>
              {cell(blk.q[2], false, { flex: 1 })}
              {cell(blk.q[3], false, { flex: 1 })}
            </View>
          </View>
        );
        const reel = reelTile(blk.tall, blk.preview, { flex: G3_QUAD_REEL_FLEX });
        return (
          <View key={`quad-${blk.tall.id}`} style={[styles.g3Block, styles.g3RowFlex, { height: G3_SPOT_H }]}>
            {blk.side === 'R' ? [grid, reel] : [reel, grid]}
          </View>
        );
      }
      case 'songquad': {
        const grid = (
          <View key="q" style={styles.g3QuadGrid}>
            <View style={[styles.g3RowFlex, styles.g3QuadRow]}>
              {cell(blk.q[0], false, { flex: 1 })}
              {cell(blk.q[1], false, { flex: 1 })}
            </View>
            <View style={[styles.g3RowFlex, styles.g3QuadRow]}>
              {cell(blk.q[2], false, { flex: 1 })}
              {cell(blk.q[3], false, { flex: 1 })}
            </View>
          </View>
        );
        const card = soundCard(blk.title, blk.songs);
        return (
          <View key={`sq-${blk.songs[0]?.id ?? blk.title}`} style={[styles.g3Block, styles.g3RowFlex, { height: G3_SPOT_H }]}>
            {blk.side === 'R' ? [grid, card] : [card, grid]}
          </View>
        );
      }
      case 'triple':
        return (
          <View key={`tri-${blk.a.id}`} style={[styles.g3Block, styles.g3RowFlex, { height: G3_SQ_H }]}>
            {cell(blk.a, false, { flex: 1 })}
            {cell(blk.b, false, { flex: 1 })}
            {cell(blk.c, false, { flex: 1 })}
          </View>
        );
      case 'trio':
        return (
          <View key={`trio-${blk.items[0]?.id ?? 'x'}`} style={[styles.g3Block, styles.g3RowFlex, { height: G3_SQ_H }]}>
            {blk.items.map((it) => isAudioPost(it.type)
              ? songCell(it, { width: G3_COL })
              : cell(it, false, { width: G3_COL }))}
          </View>
        );
      case 'duo':
        return (
          <View key={`duo-${blk.a.id}`} style={[styles.g3Block, styles.g3RowFlex, { height: G3_SQ_H }]}>
            {cell(blk.a, false, { flex: 1 })}
            {cell(blk.b, false, { flex: 1 })}
          </View>
        );
      case 'rail': return railBlock(blk.g);
      default: return null;
    }
  };

  return (
    <ScrollView {...scrollProps} contentContainerStyle={[styles.g3Scroll, bottomPad ? { paddingBottom: bottomPad } : null]}>
      {header}
      {empty ? (
        <View style={styles.empty}><Text style={styles.emptyText}>{t('exploreGrid.noPosts')}</Text></View>
      ) : (
        <View>{blocks.map(renderBlock)}</View>
      )}
    </ScrollView>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  fill: { width: '100%', height: '100%' },
  center: { alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', paddingTop: SPACING.xxl },
  emptyText: { color: colors.textTertiary, fontSize: 14 },

  // Badges / scrims shared by both variants.
  badge: {
    position: 'absolute', top: 7, left: 7, width: 20, height: 20, borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center',
  },
  userScrim: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.lg, paddingBottom: 6,
  },
  userText: { color: '#fff', fontSize: 11, fontWeight: '600' },
  songBar: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 6, paddingVertical: 4,
  },
  songBarText: { color: '#fff', fontSize: 11, fontWeight: '600' },

  // Laybell-TV hero/feature.
  tvTag: {
    position: 'absolute', top: 8, left: 8, flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: RADIUS.full, paddingHorizontal: 8, paddingVertical: 3,
  },
  tvTagText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.3 },
  tvScrim: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xl, paddingBottom: SPACING.sm,
    alignItems: 'flex-start',
  },
  watchChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: '#fff', borderRadius: RADIUS.full, paddingHorizontal: 10, paddingVertical: 4,
  },
  watchText: { color: '#000', fontSize: 11, fontWeight: '800' },

  // ── Minimal ──
  minScroll: { paddingHorizontal: MIN_PAD, paddingTop: SPACING.xs, paddingBottom: SPACING.xxl },
  minHero: { width: '100%', aspectRatio: 16 / 9, borderRadius: RADIUS.lg, overflow: 'hidden', backgroundColor: colors.surfaceLight },
  minHeroCaption: { color: colors.text, fontSize: 15, fontWeight: '700', lineHeight: 20, marginTop: 8, marginBottom: 2 },
  minRow: { flexDirection: 'row', gap: MIN_GAP, marginTop: MIN_GAP },
  minCol: { width: MIN_COL, gap: MIN_GAP },
  minTile: { width: MIN_COL, borderRadius: RADIUS.lg, overflow: 'hidden', backgroundColor: colors.surfaceLight },
  minSong: { width: MIN_COL },
  minArt: { width: MIN_COL, borderRadius: RADIUS.lg, overflow: 'hidden', backgroundColor: colors.surfaceLight },
  minSongTitle: { color: colors.text, fontSize: 13, fontWeight: '700', marginTop: 7 },
  minSongArtist: { color: colors.textSecondary, fontSize: 12, marginTop: 1 },

  // ── Grid3 (editorial mixed-span feed) ──
  g3Scroll: { paddingHorizontal: G3_PAD, paddingTop: SPACING.xs, paddingBottom: SPACING.xxl },
  g3Block: { marginBottom: G3_GAP },
  g3RowFlex: { flexDirection: 'row', gap: G3_GAP },
  g3QuadGrid: { flex: 2, gap: G3_GAP },
  g3QuadRow: { flex: 1 },
  g3Cell: { borderRadius: 2, overflow: 'hidden', backgroundColor: colors.surfaceLight },

  // Horizontal song rail.
  g3Rail: { marginTop: 6, marginBottom: 2 },
  g3RailHead: { paddingHorizontal: 4, paddingBottom: 8 },
  g3RailHeadText: { color: colors.text, fontSize: 16, fontWeight: '800', letterSpacing: -0.3 },
  g3RailRow: { gap: 7, paddingRight: 8 },
  g3RailCard: { width: G3_COL },
  g3RailArt: { width: G3_COL, height: G3_COL, borderRadius: 2, overflow: 'hidden', backgroundColor: colors.surfaceLight },
  g3RailCardTitle: { color: colors.text, fontSize: 13, fontWeight: '600', letterSpacing: -0.2, marginTop: 7 },
  g3RailCardArtist: { color: colors.textSecondary, fontSize: 11, fontWeight: '500', marginTop: 2 },

  // Sound card (songquad) — a titled menu of song rows, sized like the reel.
  g3ScCard: { padding: 6 },
  g3ScHead: { paddingHorizontal: 2, paddingBottom: 6, marginBottom: 2, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  g3ScHeadText: { color: colors.text, fontSize: 15, fontWeight: '800', letterSpacing: -0.2 },
  g3ScList: { flex: 1 },
  g3ScRow: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 2, flex: 1 },
  g3ScRowActive: { backgroundColor: colors.text + '14' },
  g3ScRowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  g3ScArt: { width: 34, height: 34, borderRadius: 3, overflow: 'hidden', backgroundColor: colors.surface },
  g3ScArtActive: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.4)' },
  g3ScRowText: { flex: 1, minWidth: 0 },
  g3ScRowTitle: { color: colors.text, fontSize: 12, fontWeight: '700' },
  g3ScRowArtist: { color: colors.textSecondary, fontSize: 10.5, marginTop: 1 },
});
