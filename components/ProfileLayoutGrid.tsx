import { Fragment, useRef, useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Dimensions } from 'react-native';
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

// ─── Autoplay loop (Big Bell hero) ────────────────────────────────────────────
// A muted, natively-looping video preview. Deliberately dead simple: no mid-play
// seek, no pause/resume machinery. The ONE rule that keeps it glitch-free is that
// the caller only MOUNTS this when the hero is actually on-screen (Posts sub-tab
// active + profile focused) and UNMOUNTS it otherwise — so every appearance is a
// fresh player that just plays. That sidesteps every failure mode we hit trying
// to keep a player alive across the tab's display:none detach (black stalls,
// reload thrash, seek stutter). The poster shows the still until the first frame.
function LoopVideo({ uri, poster, style }: { uri: string; poster?: string | null; style: any }) {
  return (
    <AppVideo
      source={{ uri }}
      style={style}
      contentFit="cover"
      poster={poster ?? undefined}
      muted
      loop
    />
  );
}

// ─── Auto-advancing slideshow (Big Bell loop slot) ────────────────────────────
// When a slideshow post sits in the loop hero, it cycles through each slide's
// thumbnail every 2s (crossfading via expo-image's transition) instead of the
// static slide-1 still. A single-slide slideshow just shows its cover.
function SlideshowLoop({ post, active = true, style }: { post: any; active?: boolean; style: any }) {
  const covers = parseSlides(post).map(slideCover).filter(Boolean);
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (covers.length <= 1 || !active) return;
    const t = setInterval(() => setIdx(i => (i + 1) % covers.length), 2000);
    return () => clearInterval(t);
  }, [covers.length, active]);
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

// ─── Thumb (module scope ON PURPOSE) ──────────────────────────────────────────
// A media thumbnail mirroring the profile grid's per-type rendering, with the
// spotlight sparkle + view/listen stat. `loop` swaps a video still for the
// autoplay preview (Big Bell).
//
// This (and the render helpers below) must NOT be declared inside
// ProfileLayoutGrid's body: a component defined during render gets a NEW
// identity every render, so React unmounts and remounts its entire subtree on
// every parent re-render — which flashed every thumbnail and tore down the
// Big Bell loop's video player before it could ever start playing.
function Thumb({ post, style, loop, loopActive, editable, spotlighted, onPress, onLongPress, registerNode }: {
  post: any;
  style: any;
  loop?: boolean;
  loopActive?: boolean;   // false → unmount the loop hero's player (tab hidden / profile off-screen)
  editable?: boolean;
  spotlighted?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  registerNode?: (n: any) => void;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  return (
    <TouchableOpacity
      activeOpacity={editable ? 0.7 : 0.85}
      style={style}
      ref={registerNode}
      onPress={onPress}
      onLongPress={onLongPress}
    >
      {loop && post.type === 'video' ? (
        // Mount the live player ONLY while the hero is on-screen. When it isn't
        // (loopActive false: tab hidden / profile off-screen) fall back to the
        // static thumbnail — the SAME image the player's poster shows — so
        // swiping away tears the player down cleanly and swiping back mounts a
        // fresh one over the identical still. No detached-player glitches.
        loopActive ? (
          <LoopVideo uri={post.media_url} poster={post.thumbnail_url} style={styles.fill} />
        ) : (
          <VideoThumb thumbnailUrl={post.thumbnail_url} mediaUrl={post.media_url} style={styles.fill} />
        )
      ) : loop && post.type === 'slideshow' ? (
        <SlideshowLoop post={post} active={loopActive} style={styles.fill} />
      ) : post.type === 'slideshow' ? (
        <>
          <ExpoImage source={{ uri: slideshowThumb(post) ?? undefined }} style={styles.fill} contentFit="cover" />
          <View style={styles.glyph}><Ionicons name="copy" size={13} color="#fff" /></View>
        </>
      ) : post.type === 'video' ? (
        <>
          <VideoThumb thumbnailUrl={post.thumbnail_url} mediaUrl={post.media_url} style={styles.fill} />
          <View style={styles.glyph}><Ionicons name="play" size={14} color="#fff" /></View>
        </>
      ) : post.type === 'image' ? (
        <ExpoImage source={{ uri: post.media_url }} style={styles.fill} contentFit="cover" />
      ) : isSongPost(post) && post.cover_url ? (
        <>
          <ExpoImage source={{ uri: post.cover_url }} style={styles.fill} contentFit="cover" />
          <View style={styles.glyph}><Ionicons name="musical-notes" size={13} color="#fff" /></View>
        </>
      ) : (
        <LinearGradient colors={['#1C0E06', '#120A04']} style={[styles.fill, styles.placeholder]}>
          <Ionicons name={isSongPost(post) ? 'musical-notes' : 'videocam'} size={26} color={colors.primary} />
        </LinearGradient>
      )}
      {/* No badge on the looping video hero: a "LIVE" tag read as a livestream
          (which it isn't) — the moving footage speaks for itself. Slideshows
          keep the "AUTO" tag since a still-cycling grid isn't self-evident. */}
      {loop && post.type === 'slideshow' && (
        <View style={styles.liveTag}><Ionicons name="albums" size={9} color="#fff" /><Text style={styles.liveText}>{t('profileGrid.auto')}</Text></View>
      )}
      {spotlighted && <SpotlightThumbBadge />}
      {!editable && <ThumbStat type={post.type} viewCount={post.view_count} streamCount={post.stream_count} />}
      {editable && (
        <View style={styles.swapBadge}><Ionicons name="swap-horizontal" size={12} color="#fff" /></View>
      )}
    </TouchableOpacity>
  );
}

export default function ProfileLayoutGrid({
  layout, posts, ownerTier, spotlightIds, playingId, artistName, active = true,
  onOpenVisual, onPlaySongs, onLongPressPost,
  editable, onSlotPress, onRemoveBlock, onToggleLoop,
}: {
  layout: PageLayout;
  posts: any[];                          // all visible posts, to resolve slot ids
  ownerTier?: string | null;             // diamond → loop heroes may autoplay
  spotlightIds?: Set<string>;
  playingId?: string | null;
  artistName?: string;
  // False pauses the looping hero — the Posts sub-tab is hidden (display:none)
  // or the profile is off-screen. Default true (builder preview is always live).
  active?: boolean;
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
  const { colors, mode } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  // Highlighted-hero accent frame color: white reads as a crisp frame on the light
  // theme, but a bright white outline GLARES in the dark themes — so on dark/grey
  // use black, which sits as a subtle inset around the hero instead. Overrides the
  // base '#fff' baked into starVisual / bigHero.
  const heroBorder = { borderColor: mode === 'light' ? '#fff' : '#000' };
  const byId = new Map(posts.map(p => [p.id, p]));
  const nodes = useRef<Record<string, any>>({});

  // Which Big Picture block gets the ANIMATED hero (video → muted 12s loop;
  // slideshow → 2s auto-advance) — exactly one per profile. An explicitly-looped
  // block wins; otherwise, in Big Bell, the FIRST block whose hero is a
  // video/slideshow animates by default, so it "just works" without the user
  // having to find the loop toggle. Other templates never animate the hero.
  const isBigBell = layout.template === 'big_bell';
  const loopBlockIndex = (() => {
    const explicit = layout.blocks.findIndex((b) => b.kind === 'big_picture' && (b as any).loop);
    if (explicit >= 0) return explicit;
    if (!isBigBell) return -1;
    return layout.blocks.findIndex((b) => b.kind === 'big_picture' && isLoopMedia(byId.get((b as any).big)));
  })();

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

  // The shared Thumb press/context wiring. In the builder, tapping a filled slot
  // re-opens its picker; an audio post sitting in a slot (e.g. a Big Picture
  // "regular") plays inline rather than opening a post page, matching the grid.
  const thumbPress = (post: any, editPress?: () => void) => () => {
    if (editable) { editPress?.(); return; }
    if (isSongPost(post)) { if (onPlaySongs) onPlaySongs([toQueueItem(post, artistName ?? '')], 0); return; }
    if (onOpenVisual) onOpenVisual(post, nodes.current[post.id]);
  };
  const thumbCommon = (post: any) => ({
    editable,
    spotlighted: spotlightIds?.has(post.id),
    onLongPress: !editable && onLongPressPost ? () => onLongPressPost(post) : undefined,
    registerNode: (n: any) => { if (n) nodes.current[post.id] = n; },
  });

  // NOTE: the helpers below are plain render FUNCTIONS (invoked, not mounted as
  // <Components/>) so they add no unstable component boundaries — see Thumb's
  // module-scope comment. Don't convert them back to JSX component usage.

  // A dashed placeholder slot (builder, empty) — tap to assign a post.
  function renderEmptySlot(style: any, icon: string, label: string, onPress?: () => void) {
    return (
      <TouchableOpacity activeOpacity={0.7} style={[style, styles.empty]} onPress={onPress}>
        <Ionicons name={icon as any} size={20} color={colors.textTertiary} />
        <Text style={styles.emptyLabel}>{label}</Text>
      </TouchableOpacity>
    );
  }

  // A compact, playable song row (Media Star right column).
  function renderSongRow(post: any | null, slotStyle: any, onPress?: () => void) {
    if (!post) {
      return renderEmptySlot(slotStyle, 'musical-notes-outline', t('profileGrid.song'), onPress);
    }
    const playing = playingId === post.id;
    return (
      <TouchableOpacity
        activeOpacity={0.8}
        style={[slotStyle, styles.songRow, playing && styles.songRowActive]}
        onPress={editable ? onPress : () => playSong(post)}
      >
        {post.cover_url ? (
          <ExpoImage source={{ uri: post.cover_url }} style={styles.songCover} contentFit="cover" />
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

  function renderRemoveBtn(onPress: () => void) {
    return (
      <TouchableOpacity style={styles.removeBtn} onPress={onPress} hitSlop={6}>
        <Ionicons name="close" size={14} color="#fff" />
      </TouchableOpacity>
    );
  }

  function renderMediaStar(block: any, i: number) {
    const main = block.main ? byId.get(block.main) : null;
    return (
      <View style={styles.starRow}>
        {main
          ? <Thumb post={main} style={[styles.starVisual, heroBorder]} onPress={thumbPress(main, () => onSlotPress?.(i, 'main'))} {...thumbCommon(main)} />
          : renderEmptySlot([styles.starVisual, heroBorder], 'image-outline', t('profileGrid.photoVideo'), editable ? () => onSlotPress?.(i, 'main') : undefined)}
        <View style={styles.starRight}>
          {[0, 1].map((s) => (
            <Fragment key={s}>
              {renderSongRow(block.songs?.[s] ? byId.get(block.songs[s]) : null, styles.starSong, editable ? () => onSlotPress?.(i, 'song', s) : undefined)}
            </Fragment>
          ))}
        </View>
        {editable && renderRemoveBtn(() => onRemoveBlock?.(i))}
      </View>
    );
  }

  function renderBigPicture(block: any, i: number) {
    const big = block.big ? byId.get(block.big) : null;
    // Animate this hero when it's the profile's single loop slot AND a video/
    // slideshow. Diamond-gated (Big Bell). See loopBlockIndex above.
    const canLoop = (ownerTier === 'diamond') && i === loopBlockIndex && isLoopMedia(big);
    return (
      <View style={styles.bigRow}>
        {big
          ? <Thumb post={big} style={[styles.bigHero, heroBorder]} loop={canLoop} loopActive={active} onPress={thumbPress(big, () => onSlotPress?.(i, 'big'))} {...thumbCommon(big)} />
          : renderEmptySlot([styles.bigHero, heroBorder], 'image-outline', t('profileGrid.heroMedia'), editable ? () => onSlotPress?.(i, 'big') : undefined)}
        <View style={styles.bigRight}>
          {[0, 1].map((s) => {
            const rp = block.regulars?.[s] ? byId.get(block.regulars[s]) : null;
            return rp
              ? <Thumb key={s} post={rp} style={styles.bigCell} onPress={thumbPress(rp, () => onSlotPress?.(i, 'regular', s))} {...thumbCommon(rp)} />
              : <Fragment key={s}>{renderEmptySlot(styles.bigCell, 'add', t('profileGrid.regular'), editable ? () => onSlotPress?.(i, 'regular', s) : undefined)}</Fragment>;
          })}
        </View>
        {editable && (
          <>
            {onToggleLoop && isLoopMedia(big) && (
              <TouchableOpacity style={[styles.loopBtn, canLoop && styles.loopBtnOn]} onPress={() => onToggleLoop(i)}>
                <Ionicons name={big.type === 'slideshow' ? 'albums' : 'sync'} size={12} color={canLoop ? '#fff' : colors.textSecondary} />
                <Text style={[styles.loopText, canLoop && { color: '#fff' }]}>{big.type === 'slideshow' ? t('profileGrid.autoSlides') : t('profileGrid.loop12s')}</Text>
              </TouchableOpacity>
            )}
            {renderRemoveBtn(() => onRemoveBlock?.(i))}
          </>
        )}
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      {layout.blocks.map((block: LayoutBlock, i) => (
        <Fragment key={i}>
          {block.kind === 'media_star' ? renderMediaStar(block, i) : renderBigPicture(block, i)}
        </Fragment>
      ))}
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
    borderWidth: 2.5, borderColor: '#fff', borderRadius: RADIUS.md, overflow: 'hidden',
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
    borderWidth: 2.5, borderColor: '#fff', borderRadius: RADIUS.md, overflow: 'hidden',
  },
  bigRight: { width: CELL },
  bigCell: { width: CELL, height: CELL, position: 'relative' },
});
