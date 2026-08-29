import { useEffect, useRef } from 'react';
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
import { useNowPlaying } from '../contexts/AudioContext';

// ── The equaliser, and how it pauses ─────────────────────────────────────────
// Four bars dancing over the artwork while the track plays. Only ever mounted
// on the loaded row — one in the whole app at a time — which is what makes it
// affordable on lists this long.
//
// PAUSING MORPHS IT INTO THE PAUSE SYMBOL rather than stamping an icon on top.
// The outer two bars fade away and the inner two rise to full height, widen and
// part, so the thing that was dancing becomes the thing that says it stopped.
// A separate badge in the corner was competing with the artwork for a job the
// equaliser was already sitting there able to do.
//
// All of it is native-driver: opacity, translate and scale only, nothing that
// touches layout.
const EQ_H = 15;
const EQ_BAR_W = 2.5;
const EQ_GAP = 2.5;
// `shift` parts the inner pair as they widen — scaleX alone would fatten the two
// bars into each other and close the gap that makes a pause icon legible.
const EQ_BARS = [
  { low: 0.30, high: 0.75, dur: 620, inner: false, shift: 0 },
  { low: 0.45, high: 1.00, dur: 470, inner: true, shift: -1.6 },
  { low: 0.25, high: 0.85, dur: 780, inner: true, shift: 1.6 },
  { low: 0.40, high: 0.95, dur: 560, inner: false, shift: 0 },
];
const EQ_PAUSE_SCALE = 1.6;

function EqBar({
  low, high, dur, inner, shift, color, playing,
}: {
  low: number; high: number; dur: number; inner: boolean; shift: number; color: string; playing: boolean;
}) {
  const v = useRef(new Animated.Value(0)).current;      // the dance
  const morph = useRef(new Animated.Value(playing ? 0 : 1)).current;  // 0 dancing, 1 paused

  useEffect(() => {
    if (!playing) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: 1, duration: dur, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(v, { toValue: 0, duration: dur, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    // Stopping FREEZES v rather than resetting it, so resuming picks the dance
    // back up mid-step instead of every bar snapping to the same height at once.
    return () => { loop.stop(); };
  }, [playing, v, dur]);

  useEffect(() => {
    Animated.timing(morph, {
      toValue: playing ? 0 : 1, duration: 280, easing: Easing.inOut(Easing.quad), useNativeDriver: true,
    }).start();
  }, [playing, morph]);

  // Bottom-anchored growth WITHOUT animating height, which would be a layout
  // pass per frame off the native driver: the bar is full height, flush with its
  // container's bottom edge, and sliding it DOWN pushes its top out of view.
  //
  // Multiplying by (1 - morph) is what blends the two states — at morph 1 the
  // offset is exactly 0, which IS full height, so the pause bars arrive at their
  // final shape without a second animation fighting the first.
  const danceY = v.interpolate({
    inputRange: [0, 1],
    outputRange: [EQ_H * (1 - low), EQ_H * (1 - high)],
  });
  const translateY = Animated.multiply(danceY, Animated.subtract(1, morph));

  // translateX and scaleX ride the CONTAINER, not the bar. The container is the
  // clip, so scaling the bar inside it would just crop the extra width away.
  // Listed translateX-then-scaleX so the scale applies first and the shift is
  // not itself scaled.
  return (
    <Animated.View
      style={{
        width: EQ_BAR_W, height: EQ_H, overflow: 'hidden', justifyContent: 'flex-end',
        opacity: inner ? 1 : morph.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
        transform: [
          { translateX: morph.interpolate({ inputRange: [0, 1], outputRange: [0, shift] }) },
          { scaleX: inner ? morph.interpolate({ inputRange: [0, 1], outputRange: [1, EQ_PAUSE_SCALE] }) : 1 },
        ],
      }}
    >
      <Animated.View
        style={{
          width: EQ_BAR_W, height: EQ_H, borderRadius: EQ_BAR_W / 2,
          backgroundColor: color, transform: [{ translateY }],
        }}
      />
    </Animated.View>
  );
}

function formatDuration(seconds?: number | null) {
  if (!seconds || seconds <= 0) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function TrackRow({
  caption, artist, username, duration, streams, cover, avatarUrl, badgeProfile, badgeOwnerId,
  isPlaying, onPlay, onCoverPress, onAddToPlaylist, onAvatarPress, onOptions, hidePlayButton, highlightQuery, spotlighted,
  trackId,
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
  // The track's own id. Optional so older call sites keep working, but without
  // it the row cannot tell PAUSED from CLOSED — see the note below.
  trackId?: string | null;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const durationLabel = formatDuration(duration);
  // Swipe-tap guard: a tab swipe gliding over the row must not start playback
  // or open a profile (presses during/just after a swipe are swallowed).
  const safePlay = guardPress(onPlay)!;
  const safeCover = guardPress(onCoverPress ?? onPlay)!;
  const safeAdd = guardPress(onAddToPlaylist);
  const safeAvatar = guardPress(onAvatarPress);
  // PAUSED vs CLOSED.
  //
  // The `isPlaying` prop cannot tell these apart. Most callers derive it from a
  // `playingId` that goes NULL the moment playback pauses, so a paused track's
  // card fell all the way back to looking like any other row — the user had no
  // way to see which song was still loaded.
  //
  // useNowPlaying is a useSyncExternalStore slice built for exactly this kind of
  // hot list surface: it publishes { id, playing } and re-renders a subscriber
  // only when one of those two flips, never on buffering or queue churn. The id
  // survives a pause (it is currentTrack?.id), so comparing against our own
  // trackId gives the state the prop could not.
  const np = useNowPlaying();
  const isCurrent = !!trackId && np.id === trackId;
  const playing = trackId ? isCurrent && np.playing : isPlaying;
  const paused = isCurrent && !np.playing;
  // Both playing AND paused wear the highlight — being the loaded track is what
  // the highlight means. Only the artwork says which of the two it is.
  const active = playing || paused;

  // Card background derived from the active theme so the sound cards fit every
  // mode (grey card in Grey, white card in Light, dark card in Dark) instead of
  // a fixed near-black.
  //
  // The active row is marked by a wash of the TEXT colour rather than brand —
  // it lifts on dark and deepens on light, so "this is the one loaded" reads in
  // every theme without spending the accent on it. Brand is for things you press.
  const cardColors = (active
    ? [colors.text + '1A', colors.surfaceLight]
    : [colors.surfaceLight, colors.surface]) as readonly [string, string];
  // Reduce Motion swaps the scrolling waveform for a static glyph. The paused
  // state itself is unaffected — it is information, not decoration.
  const reduced = useReduceMotion();
  return (
    <LinearGradient
      colors={cardColors}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.row, active && styles.rowActive]}
    >
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
        {/* The artwork carries the whole play/pause distinction, and it is the
            SAME four bars doing both: dancing while the track plays, folding
            into the pause symbol when it is held. */}
        {active && (
          <View style={styles.coverOverlayActive}>
            {reduced ? (
              <Ionicons name={playing ? 'musical-notes' : 'pause'} size={16} color={colors.text} />
            ) : (
              <View style={styles.eq}>
                {EQ_BARS.map((b, i) => (
                  <EqBar key={i} {...b} color={colors.text} playing={playing} />
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

      {/* Play / STOP — borderless filled-circle glyph, same as Today's Pick.
          The glyph is a square stop, not a pause, because that is what the
          button does: tapping the loaded track calls play() with the track
          already playing, and AudioContext's play() toggles that case straight
          to stop() — the player tears down and closes. A pause glyph promised a
          hold this control has never performed. The bottom bar's button is the
          one that actually pauses. */}
      {!hidePlayButton && (
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={playing ? t('a11y.stopPlayback') : t('a11y.play')} onPress={safePlay} onLongPress={onOptions} activeOpacity={0.8} hitSlop={6}>
          <Ionicons name={playing ? 'stop-circle' : 'play-circle'} size={44} color={colors.text} />
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
  eq: { flexDirection: 'row', alignItems: 'flex-end', gap: EQ_GAP, height: EQ_H },
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
