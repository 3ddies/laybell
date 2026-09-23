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
import FloatingComments from './FloatingComments';
import { useLoopIdle } from '../lib/playbackPresence';

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
// THE ARTWORK DRIFTS. A song card is the one card in the feed with no motion of
// its own — a photo has its subject and a video moves, while this was a still
// square with a few notes over it. A push-in and back, out and back, so it never
// snaps home.
//
// 9s each way and 1.14 of travel: enough that the card is visibly alive while
// you are looking at it, and still slow enough to read as drift rather than a
// slideshow. The pan stays inside the overscan the scale creates
// ((1.14 − 1) / 2 of the card ≈ 27pt), so no edge of the artwork can show.
const DRIFT_MS = 9_000;
const DRIFT_SCALE = 1.14;
const DRIFT_PAN = 16;
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
  /** The artist to CREDIT, or null when the card would only be repeating itself. */
  artist: string | null;
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

  // Nobody is here: hold still. The notes and this both stop on the same clock
  // the previews use (lib/playbackPresence) — a phone on a table has no use for
  // a drifting cover, and this is the app's rule for ambient motion.
  const idle = useLoopIdle();
  const drift = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (idle) return;
    const leg = (toValue: number) => Animated.timing(drift, {
      toValue, duration: DRIFT_MS, easing: Easing.inOut(Easing.sin), useNativeDriver: true,
    });
    // Out and back, so it never snaps home: a loop that only runs 0→1 would jump
    // the artwork on every repeat.
    const loop = Animated.loop(Animated.sequence([leg(1), leg(0)]));
    loop.start();
    return () => { loop.stop(); };
  }, [idle, drift]);
  const driftStyle = useMemo(() => ({
    transform: [
      { scale: drift.interpolate({ inputRange: [0, 1], outputRange: [1, DRIFT_SCALE] }) },
      { translateX: drift.interpolate({ inputRange: [0, 1], outputRange: [0, -DRIFT_PAN] }) },
      { translateY: drift.interpolate({ inputRange: [0, 1], outputRange: [0, DRIFT_PAN] }) },
    ],
  }), [drift]);

  // THE TITLE IS SIZED BY ITS OWN LENGTH (owner, 2026-09-20). One fixed size
  // cannot serve both "Halo" and a title with a parenthetical and a feature in
  // it: the short one leaves the card looking empty, and the long one eats the
  // artwork. So a short title comes in big and heavy — it has the room, and the
  // weight is what fills the space it is not using — and a long one steps down
  // until it fits without taking over the picture.
  const titleSize = useMemo(() => {
    const n = title.trim().length;
    if (n <= 12) return { fontSize: 31, lineHeight: 35, fontWeight: '900' as const, letterSpacing: -0.9 };
    if (n <= 20) return { fontSize: 27, lineHeight: 31, fontWeight: '900' as const, letterSpacing: -0.7 };
    if (n <= 32) return { fontSize: 22, lineHeight: 26, fontWeight: '800' as const, letterSpacing: -0.4 };
    return { fontSize: 18.5, lineHeight: 22, fontWeight: '800' as const, letterSpacing: -0.2 };
  }, [title]);

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
      <Animated.View style={[StyleSheet.absoluteFill, driftStyle]} pointerEvents="none">
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
      </Animated.View>

      {/* Notes ride over the artwork but UNDER the scrim, so they drift behind
          the text rather than across it. */}
      <View style={styles.noteLayer} pointerEvents="none">
        {notes.map((n, i) => <FloatingNote key={`${postId}-${i}`} {...n} />)}
      </View>

      {/* Its own band, below the notes' start and above the play control, so a
          bubble is never under the button or over the title. */}
      <FloatingComments postId={postId} max={3} travel={132} style={styles.commentLayer} />

      {/* Scrims at BOTH ends, because the content is now at both: the title top
          left, the play control bottom right. Artwork is arbitrary — it can be
          white, busy, or both — so each needs its own ground rather than
          trusting the image. The bottom one is lighter; it only has to carry a
          button, not text. */}
      <LinearGradient
        colors={['rgba(0,0,0,0.72)', 'rgba(0,0,0,0.22)', 'transparent']}
        locations={[0, 0.55, 1]}
        style={styles.scrimTop}
        pointerEvents="none"
      />
      <LinearGradient
        colors={['transparent', 'rgba(0,0,0,0.45)']}
        style={styles.scrimBottom}
        pointerEvents="none"
      />

      <View style={styles.header} pointerEvents="box-none">
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
          titleStyle={[styles.title, titleSize]}
          featStyle={styles.feat}
          onOpenProfile={onOpenProfile}
        />
        {/* Only when the artist is somebody the card has not already named — see
            the caller. A song posted by its own artist says so in the post
            header directly above this, and repeating it there is noise. */}
        {!!artist && <Text style={styles.artist} numberOfLines={1}>{artist}</Text>}
      </View>

      <View style={styles.footer} pointerEvents="box-none">
        <TouchableOpacity
          style={styles.playBtn}
          onPress={onPlay}
          activeOpacity={0.85}
          hitSlop={10}
          accessibilityRole="button"
          // STOP, not pause, because stopping is what this button does. The
          // press runs playFeedSong, which re-issues playQueue for the track
          // already playing rather than pausing it — so a pause glyph was
          // promising a resume the control cannot give. Naming the real
          // behaviour is the honest fix; the two states read play -> stop ->
          // play, which is coherent on its own terms.
          accessibilityLabel={isPlaying ? t('a11y.stop') : t('a11y.play')}
        >
          <Ionicons
            name={isPlaying ? 'stop' : 'play'}
            size={22}
            color="#fff"
            // Optical centring: a triangle's mass sits left of its bounding box,
            // so a centred play glyph reads as if it has slipped backwards. A
            // stop square is symmetrical and needs no nudge.
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
    justifyContent: 'space-between',
  },
  noteLayer: { ...StyleSheet.absoluteFillObject, top: '30%' },
  // Its own band, below the notes' start and above the play control, so a bubble
  // is never under the button or over the title.
  commentLayer: {
    position: 'absolute', left: SPACING.md, right: SPACING.md,
    bottom: 74, height: 150, justifyContent: 'flex-end',
  },
  // Taller, because the title below it is: the text needs ground under all of
  // it, not just the first line.
  scrimTop: { position: 'absolute', left: 0, right: 0, top: 0, height: '54%' },
  scrimBottom: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '32%' },
  // Top-left, and the width is capped so a marqueeing title does not run the
  // full width of the artwork — the card should still read as a picture.
  header: {
    paddingHorizontal: SPACING.md, paddingTop: SPACING.md + 2,
    maxWidth: '90%', minWidth: 0,
  },
  footer: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end',
    paddingHorizontal: SPACING.md, paddingBottom: SPACING.md,
  },
  // Always white on the scrim, never colors.text — this sits on artwork, not on
  // the theme.
  // Colour and shadow only — the SIZE comes from titleSize above, which reads
  // the title's length.
  title: { color: '#fff' },
  feat: { color: 'rgba(255,255,255,0.92)', fontSize: 16, fontWeight: '700', lineHeight: 20 },
  artist: { color: 'rgba(255,255,255,0.8)', fontSize: 14.5, marginTop: 3 },
  playBtn: {
    width: 50, height: 50, borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.34)',
  },
});
