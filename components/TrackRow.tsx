import { useEffect, useMemo, useRef } from 'react';
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

// ── The playing card's waveform ──────────────────────────────────────────────
// A strip of mirrored bars scrolling across the artwork while the track plays.
//
// ⚠️ IT IS NOT REAL AUDIO. expo-audio exposes metering for RECORDING only —
// there is no amplitude or FFT data on the playback side, and getting it would
// mean a native module, which this project does not take without asking. So the
// shape is hashed from the TRACK ID instead: every song gets its own bar pattern
// AND its own scroll speed, identical every time you play it, different from the
// song above it in the list. It is a per-song signature rather than a reading of
// the audio, and it is honest about being decorative.
//
// The whole thing is ONE animated value. The strip holds the pattern TWICE and
// slides left by exactly one pattern width before looping, so bar N+PATTERN is
// by construction the same height as bar N and the wrap is seamless. No JS runs
// per frame, and no per-bar animation exists to fall out of sync.
const WAVE_H = 17;          // tallest a bar can be
const BAR_W = 2;
const PITCH = BAR_W + 1.5;
const PATTERN = 12;         // bars per loop unit
const WAVE_W = PITCH * 9;   // visible window — about nine bars over a 50pt cover

// FNV-1a over the id, then xorshift per bar. Cheap, stable, and spread enough
// that neighbouring ids do not produce lookalike patterns.
function waveFor(seed: string): number[] {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  const out: number[] = [];
  let x = h || 1;
  for (let i = 0; i < PATTERN; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
    // Floor at 0.28 so no bar collapses to a dot, which reads as a gap rather
    // than a quiet moment.
    out.push(0.28 + (x % 1000) / 1000 * 0.72);
  }
  return out;
}

function Waveform({ seed, color, playing }: { seed: string; color: string; playing: boolean }) {
  const scroll = useRef(new Animated.Value(0)).current;
  const dim = useRef(new Animated.Value(playing ? 1 : 0)).current;

  const bars = useMemo(() => waveFor(seed), [seed]);
  // Scroll speed is seeded too, so a slow song and a fast one do not animate at
  // an identical rate just because they are both playing.
  const dur = useMemo(() => 1500 + (bars.reduce((a, b) => a + b, 0) * 220) % 1100, [bars]);

  useEffect(() => {
    if (!playing) return;
    const loop = Animated.loop(
      Animated.timing(scroll, { toValue: 1, duration: dur, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    // Paused deliberately FREEZES rather than resets: the strip holds its
    // position so resuming continues from where it stopped, the way the audio
    // does. Restarting at zero would say the track went back to the beginning.
    return () => { loop.stop(); };
  }, [playing, scroll, dur]);

  useEffect(() => {
    Animated.timing(dim, {
      toValue: playing ? 1 : 0, duration: 260, easing: Easing.out(Easing.quad), useNativeDriver: true,
    }).start();
  }, [playing, dim]);

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        width: WAVE_W, height: WAVE_H, overflow: 'hidden', justifyContent: 'center',
        opacity: dim.interpolate({ inputRange: [0, 1], outputRange: [0.42, 1] }),
      }}
    >
      <Animated.View
        style={{
          flexDirection: 'row', alignItems: 'center', height: WAVE_H,
          transform: [{ translateX: scroll.interpolate({ inputRange: [0, 1], outputRange: [0, -PATTERN * PITCH] }) }],
        }}
      >
        {/* Pattern twice over — the second copy is what the window shows while
            the first scrolls out, which is what makes the loop invisible. */}
        {[...bars, ...bars].map((h, i) => (
          <View
            key={i}
            style={{
              width: BAR_W, height: Math.round(WAVE_H * h), borderRadius: BAR_W / 2,
              backgroundColor: color, marginRight: PITCH - BAR_W,
            }}
          />
        ))}
      </Animated.View>
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
        {/* The artwork carries the whole play/pause distinction. Playing: the
            song's own waveform scrolling across. Paused: the same waveform,
            frozen where it stopped and dimmed, with a pause glyph beside it —
            visibly held rather than visibly over. */}
        {active && (
          <View style={styles.coverOverlayActive}>
            {reduced ? (
              <Ionicons name={playing ? 'musical-notes' : 'pause'} size={16} color={colors.text} />
            ) : (
              <Waveform seed={trackId || caption || 'laybell'} color={colors.text} playing={playing} />
            )}
            {paused && !reduced && (
              <View style={styles.pauseChip}>
                <Ionicons name="pause" size={9} color={colors.background} />
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
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={playing ? t('a11y.pause') : t('a11y.play')} onPress={safePlay} onLongPress={onOptions} activeOpacity={0.8} hitSlop={6}>
          <Ionicons name={playing ? 'pause-circle' : 'play-circle'} size={44} color={colors.text} />
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
  // Small pause badge tucked into the artwork's corner while the track is held.
  // The dimmed waveform alone reads as "quieter", not "stopped" — this is the
  // part that actually says paused.
  pauseChip: {
    position: 'absolute', right: 3, bottom: 3,
    width: 14, height: 14, borderRadius: 7,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.text,
  },
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
