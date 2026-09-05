import { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, Easing } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import SongCardTitle from './SongCardTitle';
import { type Feature } from '../lib/features';

// The square, poster-style rendering of a song post in the HOME FEED.
//
// Audio normally appears as a TrackRow — a compact list line, which is right for
// a catalogue and forgettable in a feed of full-bleed photos and video. Every
// third song gets this instead: cover art at post size, the title cycling with
// its credits, and a few notes drifting up over the artwork. The point is that a
// song should be able to stop the scroll the way an image does.
//
// FEED ONLY, by construction — nothing else imports this. Explore, Music and the
// profile tabs keep TrackRow, where a dense scannable list is the right shape.

const NOTE_COUNT = 3;
const NOTE_MS = 5200;
// SongCardTitle flips title↔credits on floor(positionMs / 10s) % 2, so one tick
// per 10s is all the cycling needs. A card is not a player: there is no position
// to follow, so this drives it instead — and it costs one timer per visible song
// card, only when that song actually has credits to cycle to.
const CYCLE_MS = 10_000;

/** One note: rises, drifts sideways, fades in and back out. */
function FloatingNote({ delay, startX, drift, size }: {
  delay: number; startX: number; drift: number; size: number;
}) {
  const t = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // A single 0→1 driver per note, with everything else interpolated off it —
    // one native animation instead of three, and nothing to keep in step.
    const loop = Animated.loop(
      Animated.timing(t, {
        toValue: 1,
        duration: NOTE_MS,
        delay,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => { loop.stop(); t.setValue(0); };
  }, [delay, t]);

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        bottom: 0,
        left: startX,
        opacity: t.interpolate({
          // Fades up, holds, fades out — never popping in or vanishing abruptly.
          inputRange: [0, 0.18, 0.72, 1],
          outputRange: [0, 0.5, 0.42, 0],
        }),
        transform: [
          { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [0, -190] }) },
          { translateX: t.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, drift, 0] }) },
          { scale: t.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0.7, 1, 0.92] }) },
        ],
      }}
    >
      <Ionicons name="musical-note" size={size} color="#fff" />
    </Animated.View>
  );
}

export default function SongSquareCard({
  postId, title, artist, features, cover, isPlaying, onPlay, onOpen, onOpenProfile,
}: {
  postId: string;
  title: string;
  artist: string;
  features: Feature[];
  cover: string | null;
  isPlaying: boolean;
  onPlay: () => void;
  onOpen: () => void;
  /** A credited collaborator's profile — by id, since they are not the poster. */
  onOpenProfile: (id: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();

  // Drives SongCardTitle's title↔credits flip. Only runs when there are credits
  // to flip to, and is keyed on the post so a recycled card restarts from the
  // title rather than inheriting the previous song's phase.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setTick(0);
    if (features.length === 0) return;
    const id = setInterval(() => setTick((n) => n + 1), CYCLE_MS);
    return () => clearInterval(id);
  }, [postId, features.length]);

  // Fixed per card, so the notes do not all rise in a column, and stable across
  // re-renders so they do not jump when the title cycles.
  const notes = useMemo(
    () => Array.from({ length: NOTE_COUNT }, (_, i) => ({
      delay: i * (NOTE_MS / NOTE_COUNT),
      startX: 18 + i * 26,
      drift: i % 2 === 0 ? 14 : -12,
      size: 13 + (i % 2) * 4,
    })),
    [],
  );

  return (
    <TouchableOpacity style={styles.card} activeOpacity={0.94} onPress={onOpen}>
      {cover ? (
        <ExpoImage
          source={{ uri: cover }}
          recyclingKey={postId}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          cachePolicy="memory-disk"
        />
      ) : (
        <LinearGradient colors={GRADIENTS.primary} style={StyleSheet.absoluteFill} />
      )}

      {/* Notes ride over the artwork but UNDER the scrim, so they drift behind
          the text rather than across it. */}
      <View style={styles.noteLayer} pointerEvents="none">
        {notes.map((n, i) => <FloatingNote key={`${postId}-${i}`} {...n} />)}
      </View>

      {/* Bottom scrim. Artwork is arbitrary — it can be white, busy, or both —
          so the text needs its own ground rather than trusting the image. */}
      <LinearGradient
        colors={['transparent', 'rgba(0,0,0,0.28)', 'rgba(0,0,0,0.82)']}
        locations={[0, 0.5, 1]}
        style={styles.scrim}
        pointerEvents="none"
      />

      <View style={styles.footer} pointerEvents="box-none">
        <View style={styles.textCol}>
          {/* Same component the mini player and full player use, so a title that
              is too long marquees here exactly as it does there, and credits
              stay tappable through to the collaborator's profile. */}
          <SongCardTitle
            title={title}
            features={features}
            positionMs={tick * CYCLE_MS}
            // Long enough that cycling is always permitted. The player gates it
            // at 20s so a short track does not flip mid-play; a card has no
            // playhead, and hiding a credit because the song is brief would just
            // lose information.
            durationMs={Math.max(CYCLE_MS * 6, 1)}
            titleStyle={styles.title}
            featStyle={styles.feat}
            onOpenProfile={onOpenProfile}
          />
          <Text style={styles.artist} numberOfLines={1}>{artist}</Text>
        </View>

        <TouchableOpacity
          style={styles.playBtn}
          onPress={onPlay}
          activeOpacity={0.85}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={isPlaying ? t('a11y.pause') : t('a11y.play')}
        >
          <Ionicons
            name={isPlaying ? 'pause' : 'play'}
            size={22}
            color="#fff"
            // Optical centring: a triangle's mass sits left of its bounding box,
            // so a centred play glyph reads as if it has slipped backwards.
            style={isPlaying ? undefined : { marginLeft: 3 }}
          />
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  card: {
    width: '100%', aspectRatio: 1,
    backgroundColor: colors.surfaceLight,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  noteLayer: { ...StyleSheet.absoluteFillObject, top: '38%' },
  scrim: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '55%' },
  footer: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    paddingHorizontal: SPACING.md, paddingBottom: SPACING.md,
  },
  textCol: { flex: 1, minWidth: 0 },
  // Always white on the scrim, never colors.text — this sits on artwork, not on
  // the theme.
  title: { color: '#fff', fontSize: 19, fontWeight: '800', letterSpacing: -0.3 },
  feat: { color: 'rgba(255,255,255,0.92)', fontSize: 15, fontWeight: '700' },
  artist: { color: 'rgba(255,255,255,0.78)', fontSize: 13.5, marginTop: 2 },
  playBtn: {
    width: 50, height: 50, borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.34)',
  },
});
