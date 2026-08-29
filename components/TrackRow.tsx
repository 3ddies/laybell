import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, Easing } from 'react-native';
// expo-image (NOT RN Image): decodes at DISPLAYED size and memory-caches the
// decoded bitmap, so covers paint instantly on re-appearance instead of
// re-decoding from disk (the visible split-second blank).
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { formatCount } from '../lib/format';
import { coverFade } from '../lib/coverFade';
import { guardPress } from '../contexts/PagerContext';
import HighlightText from './HighlightText';
import BadgeEmblem from './BadgeEmblem';
import { type ProfileBadgeFields } from '../lib/badges';
import { useReduceMotion } from '../lib/a11y';
import { useAudioPosition } from '../contexts/AudioContext';

// ── The playing card ─────────────────────────────────────────────────────────
// Everything below renders ONLY on the row that is currently playing, which is
// exactly one row in the whole app at a time. That is what makes it affordable:
// these rows live in FlatLists on the home feed, Music, Explore, profiles,
// playlists and Saved, so anything that ran per-row would run hundreds of times.
// Mounting on isPlaying means one equaliser, one progress line, one sheen.
//
// It is also why PlayingProgress can subscribe to the audio position at all —
// one subscriber re-rendering 4x/s, not one per visible card.

// Bar heights are fractions of EQ_H, and the durations are deliberately
// co-prime-ish so the four bars drift out of step and never pulse together.
const EQ_H = 15;
const EQ_BARS = [
  { low: 0.30, high: 0.75, dur: 620 },
  { low: 0.45, high: 1.00, dur: 470 },
  { low: 0.25, high: 0.85, dur: 780 },
  { low: 0.40, high: 0.95, dur: 560 },
];

function EqBar({ low, high, dur, color, animate }: { low: number; high: number; dur: number; color: string; animate: boolean }) {
  const v = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!animate) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: 1, duration: dur, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(v, { toValue: 0, duration: dur, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => { loop.stop(); };
  }, [animate, v, dur]);

  // Bottom-anchored growth WITHOUT animating height, which would be a layout
  // pass per frame off the native driver. The bar is full height and sits flush
  // with the container's bottom edge; sliding it DOWN pushes its top out of view
  // and the clip does the rest, so the visible stub always grows from the floor.
  const translateY = v.interpolate({
    inputRange: [0, 1],
    outputRange: [EQ_H * (1 - low), EQ_H * (1 - high)],
  });

  return (
    <View style={{ width: 2.5, height: EQ_H, overflow: 'hidden', justifyContent: 'flex-end' }}>
      <Animated.View
        style={{ width: 2.5, height: EQ_H, borderRadius: 1.25, backgroundColor: color, transform: [{ translateY }] }}
      />
    </View>
  );
}

// Live progress along the bottom of the playing card. The fill is a solid bar
// slid in from the left behind a clip rather than an animated width — same
// native-driver reveal Scrubber uses, for the same reason.
function PlayingProgress({ color, track }: { color: string; track: string }) {
  const { positionMs, durationMs } = useAudioPosition();
  const [w, setW] = useState(0);
  const anim = useRef(new Animated.Value(0)).current;
  const ratio = durationMs > 0 ? Math.max(0, Math.min(1, positionMs / durationMs)) : 0;

  useEffect(() => {
    // Before measurement, SEED instead of animating — otherwise opening a screen
    // mid-song shows the line visibly sliding in from zero.
    if (w === 0) { anim.setValue(ratio); return; }
    Animated.timing(anim, { toValue: ratio, duration: 240, useNativeDriver: true }).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratio, w]);

  return (
    <View
      pointerEvents="none"
      onLayout={(e) => setW(e.nativeEvent.layout.width)}
      style={[styles0.progressTrack, { backgroundColor: track }]}
    >
      <Animated.View
        style={{
          width: '100%', height: '100%', backgroundColor: color,
          transform: [{ translateX: anim.interpolate({ inputRange: [0, 1], outputRange: [-Math.max(1, w), 0] }) }],
        }}
      />
    </View>
  );
}

// The same sweeping sheen the Listen button uses, slowed right down. On a button
// it is an invitation to press; here it is just a sign of life, so it crosses
// once every several seconds instead of constantly.
const SHEEN_MS = 1500;
const SHEEN_REST_MS = 4200;

function CardSheen({ animate, color }: { animate: boolean; color: string }) {
  const [w, setW] = useState(0);
  const sweep = useRef(new Animated.Value(0)).current;
  const on = animate && w > 0;

  useEffect(() => {
    if (!on) return;
    sweep.setValue(0);
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(sweep, { toValue: 1, duration: SHEEN_MS, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.delay(SHEEN_REST_MS),
    ]));
    loop.start();
    // A stopped value holds where it was, which would strand the bar mid-card.
    return () => { loop.stop(); sweep.setValue(0); };
  }, [on, sweep]);

  return (
    <View
      pointerEvents="none"
      onLayout={(e) => setW(e.nativeEvent.layout.width)}
      style={styles0.sheenClip}
    >
      {on && (
        <Animated.View
          style={[
            styles0.sheen,
            { backgroundColor: color },
            { transform: [{ translateX: sweep.interpolate({ inputRange: [0, 1], outputRange: [-w * 0.5, w * 1.25] }) }, { rotate: '18deg' }] },
          ]}
        />
      )}
    </View>
  );
}

// Palette-independent styles for the three flourishes. Kept out of makeStyles
// because none of them need a theme colour — the colours are passed in from the
// row so they track colors.text, and these are pure geometry.
const styles0 = StyleSheet.create({
  progressTrack: {
    position: 'absolute', left: SPACING.md, right: SPACING.md, bottom: 6,
    height: 2, borderRadius: 1, overflow: 'hidden',
  },
  // Clips the sheen to the card. It has to be a CHILD rather than overflow on
  // the card itself: the row draws a shadow, and clipping the row's own layer
  // makes iOS compute that shadow from the layer alpha instead of its bounds.
  sheenClip: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: RADIUS.lg, overflow: 'hidden',
  },
  sheen: { position: 'absolute', top: -30, bottom: -30, width: 34 },
});

// The sheen always sweeps toward WHITE, in both themes — a dark sweep on a pale
// card reads as a smudge passing over it, not a shine. What changes is how much
// white is needed, and it is counter-intuitive: the LIGHT theme needs far more.
//
// A playing card is washed with the text colour, so on dark it sits near-black
// and 13% white is already a bright bar. On light the same wash makes a grey
// card sitting just under white, leaving almost no headroom — 13% moves it about
// four values out of 255 and is invisible. 55% lifts it back to near-white,
// which is what actually reads as a highlight crossing the card.
const SHEEN_DARK = 'rgba(255,255,255,0.13)';
const SHEEN_LIGHT = 'rgba(255,255,255,0.55)';

function formatDuration(seconds?: number | null) {
  if (!seconds || seconds <= 0) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function TrackRow({
  caption, artist, username, duration, streams, cover, avatarUrl, badgeProfile, badgeOwnerId,
  isPlaying, onPlay, onCoverPress, onAddToPlaylist, onAvatarPress, onOptions, hidePlayButton, highlightQuery, spotlighted,
}: {
  caption: string; artist: string; username: string; duration?: number | null; streams?: number;
  cover?: string | null; avatarUrl?: string | null; hidePlayButton?: boolean;
  // The track owner's badge fields + id, so their emblem shows next to the handle
  // and tapping your own opens your Badges page.
  badgeProfile?: ProfileBadgeFields | null;
  badgeOwnerId?: string | null;
  // When true, a subtle yellow sparkle shows by the handle — the track has a live
  // spotlight (publicly visible to everyone while the campaign runs).
  spotlighted?: boolean;
  isPlaying: boolean; onPlay: () => void; onCoverPress?: () => void; onAddToPlaylist?: () => void; onAvatarPress?: () => void;
  // When provided (i.e. the track belongs to the current user), long-pressing the
  // row triggers it — used app-wide for "delete my post".
  onOptions?: () => void;
  // When set (search results), matches in the caption + handle are highlighted.
  highlightQuery?: string;
}) {
  const { colors, mode } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const durationLabel = formatDuration(duration);
  // Swipe-tap guard: a tab swipe gliding over the row must not start playback
  // or open a profile (presses during/just after a swipe are swallowed).
  const safePlay = guardPress(onPlay)!;
  const safeCover = guardPress(onCoverPress ?? onPlay)!;
  const safeAdd = guardPress(onAddToPlaylist);
  const safeAvatar = guardPress(onAvatarPress);
  // Card background derived from the active theme so the sound cards fit every
  // mode (grey card in Grey, white card in Light, dark card in Dark) instead of
  // a fixed near-black.
  //
  // The playing row is marked by a wash of the TEXT colour rather than brand —
  // it lifts on dark and deepens on light, so "this is the one playing" reads in
  // every theme without spending the accent on it. Brand is for things you press.
  const cardColors = (isPlaying
    ? [colors.text + '1A', colors.surfaceLight]
    : [colors.surfaceLight, colors.surface]) as readonly [string, string];
  // Reduce Motion turns off the equaliser and the sheen — both are decorative.
  // The progress line stays: it is information, not decoration.
  const reduced = useReduceMotion();
  const flourish = isPlaying && !reduced;
  return (
    <LinearGradient
      colors={cardColors}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.row, isPlaying && styles.rowActive]}
    >
      {/* Sheen first so it sits UNDER everything — it is a highlight passing
          across the card, not a film over the artwork and text. */}
      {flourish && <CardSheen animate color={mode === 'light' ? SHEEN_LIGHT : SHEEN_DARK} />}

      {/* Cover art (left) — tap to expand to the now-playing screen.
          Long-press opens the options sheet from ANY part of the row. */}
      <TouchableOpacity style={styles.coverWrap} onPress={safeCover} onLongPress={onOptions}>
        {cover ? (
          <ExpoImage source={{ uri: cover }} style={[styles.cover, styles.coverImg]} contentFit="cover" cachePolicy="memory-disk" transition={coverFade(cover)} />
        ) : (
          <LinearGradient colors={GRADIENTS.primarySoft} style={styles.cover}>
            <Ionicons name="musical-notes" size={18} color={colors.primary} />
          </LinearGradient>
        )}
        {/* A dancing equaliser rather than a static note: on a card that IS the
            thing currently making sound, a frozen glyph was the one detail
            saying nothing is happening. Falls back to the note under Reduce
            Motion so the playing row is still marked. */}
        {isPlaying && (
          <View style={styles.coverOverlayActive}>
            {reduced ? (
              <Ionicons name="musical-notes" size={16} color={colors.text} />
            ) : (
              <View style={styles.eq}>
                {EQ_BARS.map((b, i) => (
                  <EqBar key={i} low={b.low} high={b.high} dur={b.dur} color={colors.text} animate />
                ))}
              </View>
            )}
          </View>
        )}
      </TouchableOpacity>

      {/* Track outline — tap to play/pause, long-press for options (own tracks) */}
      <TouchableOpacity style={styles.info} activeOpacity={0.7} onPress={safePlay} onLongPress={onOptions}>
        <HighlightText text={caption || t('postView.audioTrack')} query={highlightQuery} style={styles.caption} highlightStyle={styles.hl} numberOfLines={1} />
        <View style={styles.meta}>
          <HighlightText text={`@${username}`} query={highlightQuery} style={styles.artist} highlightStyle={styles.hl} numberOfLines={1} />
          <BadgeEmblem profile={badgeProfile} ownerId={badgeOwnerId} size={11} />
          {spotlighted && <Ionicons name="sparkles" size={11} color={colors.primaryLight} />}
          <Ionicons name="play" size={9} color={colors.textTertiary} />
          <Text style={styles.streams}>{formatCount(streams)}</Text>
          {durationLabel && <Text style={styles.artist}>· {durationLabel}</Text>}
        </View>
      </TouchableOpacity>

      {/* Play / pause — borderless filled-circle glyph, same as Today's Pick */}
      {!hidePlayButton && (
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={isPlaying ? t('a11y.pause') : t('a11y.play')} onPress={safePlay} onLongPress={onOptions} activeOpacity={0.8} hitSlop={6}>
          <Ionicons name={isPlaying ? 'pause-circle' : 'play-circle'} size={44} color={colors.text} />
        </TouchableOpacity>
      )}

      {onAddToPlaylist && (
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.add')} style={styles.addBtn} onPress={safeAdd} onLongPress={onOptions}>
          <Ionicons name="add-circle-outline" size={22} color={colors.primary} />
        </TouchableOpacity>
      )}

      {/* Artist avatar (right) — tap to open profile */}
      {onAvatarPress && (
        <TouchableOpacity onPress={safeAvatar} onLongPress={onOptions}>
          {avatarUrl ? (
            <ExpoImage source={{ uri: avatarUrl }} style={styles.avatar} contentFit="cover" cachePolicy="memory-disk" />
          ) : (
            <LinearGradient colors={GRADIENTS.avatar} style={styles.avatar}>
              <Text style={styles.avatarText}>{(artist || username || '?').charAt(0).toUpperCase()}</Text>
            </LinearGradient>
          )}
        </TouchableOpacity>
      )}

      {/* Live position along the foot of the card. Last child so it draws over
          the wash, and inset to the card's own padding so it never has to fight
          the corner radius. */}
      {isPlaying && <PlayingProgress color={colors.text} track={colors.text + '24'} />}
    </LinearGradient>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center',
    borderRadius: RADIUS.lg,
    padding: SPACING.md, borderWidth: 1, borderColor: colors.border, gap: SPACING.md,
    // Opaque base under the gradient fill (invisible) — without it, iOS can't
    // use the fast bounds shadowPath and computes the shadow from the layer's
    // alpha: an offscreen pass per audio card while the feed scrolls.
    backgroundColor: colors.surface,
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  rowActive: { borderColor: colors.borderStrong },
  coverWrap: {
    width: 50, height: 50, borderRadius: RADIUS.md, overflow: 'hidden',
    borderWidth: 1, borderColor: colors.borderSubtle,
  },
  cover: { width: 50, height: 50, borderRadius: RADIUS.md, alignItems: 'center', justifyContent: 'center' },
  // Applied to the IMAGE only, never the shared no-cover gradient fallback
  // (primarySoft is semi-transparent, so a background under it would tint it).
  // Acts as the load placeholder: a neutral theme tile the cover fades in over.
  coverImg: { backgroundColor: colors.surfaceLight },
  // Scrim over the artwork of the playing row. Takes the PAGE colour, not a
  // fixed dark: the note glyph on top is colors.text, so a black scrim would
  // hide a near-black glyph in light mode. Page colour is the one value
  // guaranteed to contrast with the text colour in every theme.
  coverOverlayActive: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background + '8C',
  },
  eq: { flexDirection: 'row', alignItems: 'flex-end', gap: 2.5, height: EQ_H },
  info: { flex: 1 },
  // The song name is the row's headline and its primary tap target (the whole
  // info column plays the track), so it carries real weight; the handle and the
  // stream/duration meta drop back to a supporting line. At 14 vs 12 the two
  // read as near-equal and the eye had to pick.
  caption: { color: colors.text, fontSize: 16, fontWeight: '800', letterSpacing: -0.3 },
  hl: { color: colors.primary, fontWeight: '800' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  artist: { color: colors.textSecondary, fontSize: 11.5 },
  streams: { color: colors.textTertiary, fontSize: 11.5 },
  addBtn: { padding: SPACING.xs },
  avatar: { width: 34, height: 34, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceElevated },
  avatarText: { color: colors.text, fontSize: 14, fontWeight: '700' },
});
