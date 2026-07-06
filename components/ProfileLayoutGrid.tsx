import { useRef, useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image, Dimensions } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import AppVideo from './AppVideo';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { slideshowThumb, parseSlides, slideCover } from '../lib/slideshow';
import VideoThumb from './VideoThumb';
import ThumbStat from './ThumbStat';
import SpotlightThumbBadge from './SpotlightThumbBadge';
import { isSongPost, isLoopMedia, type LayoutBlock, type PageLayout } from '../lib/pageLayout';

const SCREEN_W = Dimensions.get('window').width;
const CELL = SCREEN_W / 3;                 // a regular 1×1 grid cell
const STAR_VISUAL = SCREEN_W * 0.5;        // Media Star hero = left half, square

// A queue entry for the audio player, built from an audio post.
type SongQueueItem = { id: string; uri: string; caption: string; artist: string; cover: string | null };
function toQueueItem(p: any, artist: string): SongQueueItem {
  return { id: p.id, uri: p.media_url, caption: p.caption, artist: p.profiles?.display_name ?? artist, cover: p.cover_url ?? null };
}

// ─── 12s autoplay loop (Big Bell hero) ────────────────────────────────────────
// A muted, looping video preview capped at 12s. `isLooping` restarts the whole
// clip; the status callback also snaps back at 12s so longer videos only ever
// show their first 12 seconds.
function LoopVideo({ uri, style }: { uri: string; style: any }) {
  return (
    <AppVideo
      source={{ uri }}
      style={style}
      contentFit="cover"
      muted
      active
      loop
      // Cap the preview at 12s: snap back to the start so longer clips only ever
      // show their first 12 seconds (shorter clips loop naturally via `loop`).
      trimEndSec={12}
    />
  );
}

// ─── Auto-advancing slideshow (Big Bell loop slot) ────────────────────────────
// When a slideshow post sits in the loop hero, it cycles through each slide's
// thumbnail every 2s (crossfading via expo-image's transition) instead of the
// static slide-1 still. A single-slide slideshow just shows its cover.
function SlideshowLoop({ post, style }: { post: any; style: any }) {
  const covers = parseSlides(post).map(slideCover).filter(Boolean);
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (covers.length <= 1) return;
    const t = setInterval(() => setIdx(i => (i + 1) % covers.length), 2000);
    return () => clearInterval(t);
  }, [covers.length]);
  const uri = covers[idx] ?? covers[0] ?? slideshowThumb(post) ?? undefined;
  return (
    <View style={style}>
      <ExpoImage source={{ uri }} style={loopStyles.fill} contentFit="cover" transition={500} />
      {covers.length > 1 && (
        <View style={loopStyles.dots}>
          {covers.map((_, k) => <View key={k} style={[loopStyles.dot, k === idx && loopStyles.dotOn]} />)}
        </View>
      )}
    </View>
  );
}
const loopStyles = StyleSheet.create({
  fill: { width: '100%', height: '100%' },
  dots: { position: 'absolute', bottom: 8, alignSelf: 'center', flexDirection: 'row', gap: 4 },
  dot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: 'rgba(255,255,255,0.45)' },
  dotOn: { backgroundColor: '#fff', width: 7, height: 7, borderRadius: 3.5 },
});

export default function ProfileLayoutGrid({
  layout, posts, ownerTier, spotlightIds, playingId, artistName,
  onOpenVisual, onPlaySongs, onLongPressPost,
  editable, onSlotPress, onRemoveBlock, onToggleLoop,
}: {
  layout: PageLayout;
  posts: any[];                          // all visible posts, to resolve slot ids
  ownerTier?: string | null;             // diamond → loop heroes may autoplay
  spotlightIds?: Set<string>;
  playingId?: string | null;
  artistName?: string;
  // Render-mode actions (omitted in the builder).
  onOpenVisual?: (post: any, node?: any) => void;
  onPlaySongs?: (queue: SongQueueItem[], index: number) => void;
  onLongPressPost?: (post: any) => void;
  // Builder-mode props: slots become tappable assign/replace targets and each
  // block gets remove / loop controls.
  editable?: boolean;
  onSlotPress?: (blockIndex: number, field: string, subIndex?: number) => void;
  onRemoveBlock?: (blockIndex: number) => void;
  onToggleLoop?: (blockIndex: number) => void;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const byId = new Map(posts.map(p => [p.id, p]));
  const nodes = useRef<Record<string, any>>({});

  // All songs across the layout, in block order — tapping one plays the whole
  // run so a Media Star profile plays continuously cluster to cluster.
  const songQueue: { id: string; post: any }[] = [];
  for (const b of layout.blocks) {
    if (b.kind === 'media_star') for (const id of b.songs) { const p = byId.get(id); if (p) songQueue.push({ id, post: p }); }
  }

  function playSong(post: any) {
    if (!onPlaySongs) return;
    const queue = songQueue.map(s => toQueueItem(s.post, artistName ?? ''));
    const idx = songQueue.findIndex(s => s.id === post.id);
    onPlaySongs(queue, Math.max(0, idx));
  }

  // A media thumbnail mirroring the profile grid's per-type rendering, with the
  // spotlight sparkle + view/listen stat. `loop` swaps a video still for the
  // autoplay preview (Big Bell). Tapping opens the post/reel (render mode).
  function Thumb({ post, style, loop, editPress }: { post: any; style: any; loop?: boolean; editPress?: () => void }) {
    const open = () => {
      // In the builder, tapping a filled slot re-opens its picker.
      if (editable) { editPress?.(); return; }
      // An audio post sitting in a slot (e.g. a Big Picture "regular") plays
      // inline rather than opening a post page, matching the normal grid.
      if (isSongPost(post)) { if (onPlaySongs) onPlaySongs([toQueueItem(post, artistName ?? '')], 0); return; }
      if (onOpenVisual) onOpenVisual(post, nodes.current[post.id]);
    };
    return (
      <TouchableOpacity
        activeOpacity={editable ? 0.7 : 0.85}
        style={style}
        ref={(n) => { if (n) nodes.current[post.id] = n; }}
        onPress={open}
        onLongPress={!editable && onLongPressPost ? () => onLongPressPost(post) : undefined}
      >
        {loop && post.type === 'video' ? (
          <LoopVideo uri={post.media_url} style={styles.fill} />
        ) : loop && post.type === 'slideshow' ? (
          <SlideshowLoop post={post} style={styles.fill} />
        ) : post.type === 'slideshow' ? (
          <>
            <Image source={{ uri: slideshowThumb(post) ?? undefined }} style={styles.fill} resizeMode="cover" />
            <View style={styles.glyph}><Ionicons name="copy" size={13} color="#fff" /></View>
          </>
        ) : post.type === 'video' ? (
          <>
            <VideoThumb thumbnailUrl={post.thumbnail_url} mediaUrl={post.media_url} style={styles.fill} />
            <View style={styles.glyph}><Ionicons name="play" size={14} color="#fff" /></View>
          </>
        ) : post.type === 'image' ? (
          <Image source={{ uri: post.media_url }} style={styles.fill} resizeMode="cover" />
        ) : isSongPost(post) && post.cover_url ? (
          <>
            <Image source={{ uri: post.cover_url }} style={styles.fill} resizeMode="cover" />
            <View style={styles.glyph}><Ionicons name="musical-notes" size={13} color="#fff" /></View>
          </>
        ) : (
          <LinearGradient colors={['#1C0E06', '#120A04']} style={[styles.fill, styles.placeholder]}>
            <Ionicons name={isSongPost(post) ? 'musical-notes' : 'videocam'} size={26} color={colors.primary} />
          </LinearGradient>
        )}
        {loop && post.type === 'video' && (
          <View style={styles.liveTag}><Ionicons name="ellipse" size={7} color="#fff" /><Text style={styles.liveText}>{t('profileGrid.live')}</Text></View>
        )}
        {loop && post.type === 'slideshow' && (
          <View style={styles.liveTag}><Ionicons name="albums" size={9} color="#fff" /><Text style={styles.liveText}>{t('profileGrid.auto')}</Text></View>
        )}
        {spotlightIds?.has(post.id) && <SpotlightThumbBadge />}
        {!editable && <ThumbStat type={post.type} viewCount={post.view_count} streamCount={post.stream_count} />}
        {editable && (
          <View style={styles.swapBadge}><Ionicons name="swap-horizontal" size={12} color="#fff" /></View>
        )}
      </TouchableOpacity>
    );
  }

  // A dashed placeholder slot (builder, empty) — tap to assign a post.
  function EmptySlot({ style, icon, label, onPress }: { style: any; icon: string; label: string; onPress?: () => void }) {
    return (
      <TouchableOpacity activeOpacity={0.7} style={[style, styles.empty]} onPress={onPress}>
        <Ionicons name={icon as any} size={20} color={colors.textTertiary} />
        <Text style={styles.emptyLabel}>{label}</Text>
      </TouchableOpacity>
    );
  }

  // A compact, playable song row (Media Star right column).
  function SongRow({ post, slotStyle, onPress }: { post: any | null; slotStyle: any; onPress?: () => void }) {
    if (!post) {
      return <EmptySlot style={slotStyle} icon="musical-notes-outline" label={t('profileGrid.song')} onPress={onPress} />;
    }
    const playing = playingId === post.id;
    return (
      <TouchableOpacity
        activeOpacity={0.8}
        style={[slotStyle, styles.songRow, playing && styles.songRowActive]}
        onPress={editable ? onPress : () => playSong(post)}
      >
        {post.cover_url ? (
          <Image source={{ uri: post.cover_url }} style={styles.songCover} />
        ) : (
          <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.songCover}>
            <Ionicons name="musical-notes" size={16} color={colors.primary} />
          </LinearGradient>
        )}
        <View style={styles.songInfo}>
          <Text style={styles.songTitle} numberOfLines={1}>{post.caption || t('postView.audioTrack')}</Text>
          <View style={styles.songMeta}>
            <Ionicons name="play" size={9} color={colors.textTertiary} />
            <Text style={styles.songStreams} numberOfLines={1}>{post.stream_count ?? 0}</Text>
          </View>
        </View>
        <Ionicons name={playing ? 'pause-circle' : 'play-circle'} size={30} color={colors.primary} />
      </TouchableOpacity>
    );
  }

  function MediaStar({ block, i }: { block: any; i: number }) {
    const main = block.main ? byId.get(block.main) : null;
    return (
      <View style={styles.starRow}>
        {main
          ? <Thumb post={main} style={styles.starVisual} editPress={editable ? () => onSlotPress?.(i, 'main') : undefined} />
          : <EmptySlot style={styles.starVisual} icon="image-outline" label={t('profileGrid.photoVideo')} onPress={editable ? () => onSlotPress?.(i, 'main') : undefined} />}
        <View style={styles.starRight}>
          {[0, 1].map((s) => (
            <SongRow key={s} post={block.songs?.[s] ? byId.get(block.songs[s]) : null} slotStyle={styles.starSong} onPress={editable ? () => onSlotPress?.(i, 'song', s) : undefined} />
          ))}
        </View>
        {editable && <RemoveBtn onPress={() => onRemoveBlock?.(i)} />}
      </View>
    );
  }

  function BigPicture({ block, i }: { block: any; i: number }) {
    const big = block.big ? byId.get(block.big) : null;
    const canLoop = (ownerTier === 'diamond') && !!block.loop;
    return (
      <View style={styles.bigRow}>
        {big
          ? <Thumb post={big} style={styles.bigHero} loop={canLoop} editPress={editable ? () => onSlotPress?.(i, 'big') : undefined} />
          : <EmptySlot style={styles.bigHero} icon="image-outline" label={t('profileGrid.heroMedia')} onPress={editable ? () => onSlotPress?.(i, 'big') : undefined} />}
        <View style={styles.bigRight}>
          {[0, 1].map((s) => {
            const rp = block.regulars?.[s] ? byId.get(block.regulars[s]) : null;
            return rp
              ? <Thumb key={s} post={rp} style={styles.bigCell} editPress={editable ? () => onSlotPress?.(i, 'regular', s) : undefined} />
              : <EmptySlot key={s} style={styles.bigCell} icon="add" label={t('profileGrid.regular')} onPress={editable ? () => onSlotPress?.(i, 'regular', s) : undefined} />;
          })}
        </View>
        {editable && (
          <>
            {onToggleLoop && isLoopMedia(big) && (
              <TouchableOpacity style={[styles.loopBtn, block.loop && styles.loopBtnOn]} onPress={() => onToggleLoop(i)}>
                <Ionicons name={big.type === 'slideshow' ? 'albums' : 'sync'} size={12} color={block.loop ? '#fff' : colors.textSecondary} />
                <Text style={[styles.loopText, block.loop && { color: '#fff' }]}>{big.type === 'slideshow' ? t('profileGrid.autoSlides') : t('profileGrid.loop12s')}</Text>
              </TouchableOpacity>
            )}
            <RemoveBtn onPress={() => onRemoveBlock?.(i)} />
          </>
        )}
      </View>
    );
  }

  function RemoveBtn({ onPress }: { onPress: () => void }) {
    return (
      <TouchableOpacity style={styles.removeBtn} onPress={onPress} hitSlop={6}>
        <Ionicons name="close" size={14} color="#fff" />
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.wrap}>
      {layout.blocks.map((block: LayoutBlock, i) =>
        block.kind === 'media_star'
          ? <MediaStar key={i} block={block} i={i} />
          : <BigPicture key={i} block={block} i={i} />,
      )}
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  wrap: { width: '100%' },
  fill: { width: '100%', height: '100%' },
  placeholder: { alignItems: 'center', justifyContent: 'center', borderWidth: 0.5, borderColor: colors.border },
  glyph: {
    position: 'absolute', top: 6, left: 6, width: 20, height: 20, borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center',
  },
  liveTag: {
    position: 'absolute', top: 6, right: 6, flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: RADIUS.full, paddingHorizontal: 6, paddingVertical: 2,
  },
  liveText: { color: '#fff', fontSize: 8, fontWeight: '900', letterSpacing: 0.5 },

  empty: {
    alignItems: 'center', justifyContent: 'center', gap: 4,
    borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.border,
    backgroundColor: colors.surfaceLight,
  },
  emptyLabel: { color: colors.textTertiary, fontSize: 11, fontWeight: '600' },

  // Per-block controls (builder).
  removeBtn: {
    position: 'absolute', top: 6, right: 6, width: 24, height: 24, borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', zIndex: 5,
  },
  swapBadge: {
    position: 'absolute', bottom: 6, left: 6, width: 22, height: 22, borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center',
  },
  loopBtn: {
    position: 'absolute', bottom: 6, right: CELL + 6, flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: RADIUS.full, paddingHorizontal: 8, paddingVertical: 4, zIndex: 5,
  },
  loopBtnOn: { backgroundColor: colors.primary },
  loopText: { color: colors.textSecondary, fontSize: 10, fontWeight: '700' },

  // ── Media Star cluster ──
  starRow: { flexDirection: 'row', width: '100%', height: STAR_VISUAL, position: 'relative' },
  // The highlighted hero gets a prominent accent frame so it reads as the
  // centerpiece of the cluster (owner: "more border around highlighted content").
  starVisual: {
    width: STAR_VISUAL, height: STAR_VISUAL, position: 'relative',
    borderWidth: 2.5, borderColor: colors.primary, borderRadius: RADIUS.md, overflow: 'hidden',
  },
  starRight: { flex: 1, padding: 6, gap: 6, justifyContent: 'center' },
  starSong: { flex: 1 },
  songRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    borderRadius: RADIUS.md, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surfaceLight, paddingHorizontal: SPACING.sm, paddingVertical: 6,
  },
  songRowActive: { borderColor: colors.primary + '66' },
  songCover: { width: 42, height: 42, borderRadius: RADIUS.sm, alignItems: 'center', justifyContent: 'center' },
  songInfo: { flex: 1, minWidth: 0 },
  songTitle: { color: colors.text, fontSize: 13, fontWeight: '700' },
  songMeta: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 1 },
  songStreams: { color: colors.textTertiary, fontSize: 11 },

  // ── Big Picture block ──
  bigRow: { flexDirection: 'row', width: '100%', height: CELL * 2, position: 'relative' },
  // Highlighted hero gets the same prominent accent frame as Media Star.
  bigHero: {
    width: CELL * 2, height: CELL * 2, position: 'relative',
    borderWidth: 2.5, borderColor: colors.primary, borderRadius: RADIUS.md, overflow: 'hidden',
  },
  bigRight: { width: CELL },
  bigCell: { width: CELL, height: CELL, position: 'relative' },
});
