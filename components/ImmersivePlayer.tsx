import { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated, Easing,
  PanResponder, useWindowDimensions,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAudio, useAudioPosition } from '../contexts/AudioContext';
import { SPACING, type ThemePalette } from '../constants/theme';
import { useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import FloatingComments from './FloatingComments';

// A full-bleed listening view, reached by tapping the artwork in Now Playing.
//
// The cover fills the screen and PANS slowly across as the song plays, so the
// image is doing the same job the progress bar is — you can tell roughly where
// you are without reading anything. Underneath sits a waveform scrubber.
//
// ⚠️ THE WAVEFORM IS SYNTHETIC, and that is a deliberate, disclosed choice.
// Nothing in this app stores audio peaks: real ones need computing at upload
// time plus somewhere to keep them, which is a server change. These bars are
// generated from a hash of the TRACK ID, so they are stable — a given song looks
// identical every time you open it, on every device — but they do not describe
// the actual audio. They are a scrubber that reads as a waveform, not a
// visualisation. If real peaks ever get stored, only `bars` below has to change.
//
// TIMED COMMENTS are not here. They need a position column on `comments`, which
// is a live database change against the shipped app; deferred on purpose.

const BARS = 68;
const BAR_GAP = 2;

// Deterministic 0..1 sequence from a string. Not cryptographic and does not need
// to be — it needs to be STABLE, so the same song never redraws differently.
function barsFor(seed: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  const out: number[] = [];
  for (let i = 0; i < BARS; i++) {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h |= 0;
    const r = Math.abs(h % 1000) / 1000;
    // Bias toward the middle of the range and add a slow swell across the track,
    // so it reads as music rather than as noise: real waveforms have shape.
    const swell = 0.55 + 0.45 * Math.sin((i / BARS) * Math.PI * 2.3);
    out.push(0.22 + 0.78 * (0.35 * r + 0.65 * swell) * (0.6 + 0.4 * r));
  }
  return out;
}

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export default function ImmersivePlayer({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { width: SW, height: SH } = useWindowDimensions();
  const { currentTrack, isPlaying, pause, resume, seekTo, next, previous } = useAudio();
  const { positionMs, durationMs } = useAudioPosition();

  const ratio = durationMs > 0 ? Math.max(0, Math.min(1, positionMs / durationMs)) : 0;
  const bars = useMemo(() => barsFor(currentTrack?.id ?? 'laybell'), [currentTrack?.id]);

  // Native-driven so the pan and the fill never touch the JS thread while a song
  // is playing — the same reasoning as Scrubber, and it matters more here because
  // a full-screen image is being transformed.
  const prog = useRef(new Animated.Value(0)).current;
  const dragging = useRef(false);
  const [dragRatio, setDragRatio] = useState<number | null>(null);

  useEffect(() => {
    if (dragging.current) return;
    Animated.timing(prog, { toValue: ratio, duration: 260, easing: Easing.linear, useNativeDriver: true }).start();
  }, [ratio, prog]);

  // Entrance/exit. Kept mounted through the exit so closing is a fade, and the
  // artwork is never torn down mid-animation — the lesson from the song card.
  const enter = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(visible);
  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.timing(enter, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
      return;
    }
    Animated.timing(enter, { toValue: 0, duration: 200, easing: Easing.in(Easing.quad), useNativeDriver: true })
      .start(({ finished }) => { if (finished) setMounted(false); });
  }, [visible, enter]);

  // ── Waveform scrubbing ──────────────────────────────────────────────────────
  const trackW = SW - SPACING.lg * 2;
  const barW = (trackW - BAR_GAP * (BARS - 1)) / BARS;
  const wrapRef = useRef<View>(null);
  const wrapX = useRef(0);
  const wrapW = useRef(trackW);

  // PanResponder.create runs ONCE inside a useRef, so its handlers close over the
  // FIRST render's values forever. durationMs is 0 on that render, so
  // `if (durationMs > 0) seekTo(...)` was permanently false and the release never
  // seeked — dragging moved the bar and then snapped back, which is exactly the
  // "doesn't work that well" the owner hit. Everything the handlers read now
  // lives in a ref that each render refreshes. Scrubber already does this with
  // onSeekRef for the same reason; this file failed to copy it.
  const durRef = useRef(durationMs); durRef.current = durationMs;
  const seekRef = useRef(seekTo); seekRef.current = seekTo;
  // Same discipline for everything the SCREEN responder reads.
  const ratioRef = useRef(ratio); ratioRef.current = ratio;
  const playingRef = useRef(isPlaying); playingRef.current = isPlaying;
  const pauseRef = useRef(pause); pauseRef.current = pause;
  const resumeRef = useRef(resume); resumeRef.current = resume;
  const swRef = useRef(SW); swRef.current = SW;

  const ratioAt = (pageX: number) => Math.max(0, Math.min(1, (pageX - wrapX.current) / (wrapW.current || 1)));

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        dragging.current = true;
        const r = ratioAt(e.nativeEvent.pageX);
        prog.setValue(r); setDragRatio(r);
      },
      onPanResponderMove: (e) => {
        const r = ratioAt(e.nativeEvent.pageX);
        prog.setValue(r); setDragRatio(r);
      },
      onPanResponderRelease: (e) => {
        const r = ratioAt(e.nativeEvent.pageX);
        dragging.current = false; setDragRatio(null);
        if (durRef.current > 0) seekRef.current(Math.floor(r * durRef.current));
      },
      onPanResponderTerminate: () => { dragging.current = false; setDragRatio(null); },
    }),
  ).current;

  // ── The whole screen is the control ─────────────────────────────────────────
  // Drag anywhere to scrub, tap anywhere to play/pause.
  //
  // RELATIVE, not absolute. Mapping x-position straight to song-position would be
  // simpler, but then a TAP is also a seek — and tap has to mean play/pause. A
  // drag that moves nothing changes nothing, which is what lets the two gestures
  // share the same surface without argument.
  //
  // It sits BELOW the header and transport in the tree, so those keep their own
  // touches: responder negotiation offers a touch to the deepest view first, and
  // this only claims what nothing else wanted. The waveform's own responder wins
  // over it for the same reason.
  const screenStart = useRef(0);
  const screenMoved = useRef(false);
  const screenPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      // Only take over once the finger has actually travelled, and travelled
      // MORE HORIZONTALLY than vertically — otherwise a vertical swipe would
      // scrub, which is nobody's intent.
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => { screenStart.current = ratioRef.current; screenMoved.current = false; },
      onPanResponderMove: (_e, g) => {
        if (Math.abs(g.dx) > 6) screenMoved.current = true;
        if (!screenMoved.current) return;
        dragging.current = true;
        // A full screen-width drag covers the whole song, matching the waveform
        // below it so the two controls feel like one scale.
        const r = Math.max(0, Math.min(1, screenStart.current + g.dx / (swRef.current || 1)));
        prog.setValue(r); setDragRatio(r);
      },
      onPanResponderRelease: (_e, g) => {
        if (screenMoved.current) {
          const r = Math.max(0, Math.min(1, screenStart.current + g.dx / (swRef.current || 1)));
          dragging.current = false; setDragRatio(null);
          if (durRef.current > 0) seekRef.current(Math.floor(r * durRef.current));
          return;
        }
        // Never moved → it was a tap.
        if (playingRef.current) pauseRef.current(); else resumeRef.current();
      },
      onPanResponderTerminate: () => { dragging.current = false; setDragRatio(null); },
    }),
  ).current;

  if (!mounted || !currentTrack) return null;

  // The cover is rendered wider than the screen and slid left as the song plays.
  //
  // artH is the one that controls ZOOM, which is not obvious. A square cover in a
  // box taller than it is wide gets scaled to the box's HEIGHT no matter how wide
  // the box is — so widening it only adds pan distance, while the magnification
  // stays pinned to the screen height. Shortening the box is the only thing that
  // zooms out, which is why the owner's "photo may be zoomed in a bit too much"
  // is fixed here at 0.82 rather than by touching artW.
  //
  // The missing 18% at the bottom sits under the darkest part of the scrim, where
  // the controls are, so the edge never shows.
  const artW = SW * 1.35;
  const artH = SH * 0.82;
  const panX = prog.interpolate({ inputRange: [0, 1], outputRange: [0, -(artW - SW)] });
  const playedMs = dragRatio != null ? dragRatio * durationMs : positionMs;

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.root, { opacity: enter }]}>
      {/* Background: the artwork itself, panning. */}
      <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ translateX: panX }] }]}>
        {currentTrack.cover ? (
          <ExpoImage
            source={{ uri: currentTrack.cover }}
            style={{ width: artW, height: artH }}
            contentFit="cover"
            cachePolicy="memory-disk"
          />
        ) : (
          <View style={{ width: artW, height: artH, backgroundColor: '#111' }} />
        )}
      </Animated.View>
      {/* Notes go UNDER the scrim on purpose: its top and bottom bands then dim
          any note drifting into the title or the transport, so they never
          compete with the text they are floating past. */}
      <FloatingNotes playing={visible && isPlaying} w={SW} h={SH} />

      {/* Legibility scrim. Heavier at top and bottom, where all the text is —
          the middle stays clear so the artwork is actually visible, which is the
          entire point of the screen. */}
      <LinearGradient
        colors={['rgba(0,0,0,0.58)', 'rgba(0,0,0,0)', 'rgba(0,0,0,0)', 'rgba(0,0,0,0.94)']}
        locations={[0, 0.22, 0.5, 0.88]}
        style={StyleSheet.absoluteFill}
      />

      {/* The gesture surface. Above the artwork so it can be touched, below the
          controls so they still win their own taps. */}
      <View style={StyleSheet.absoluteFill} {...screenPan.panHandlers} />

      {/* The room reacting. Same component the feed's square song card uses, on
          the same comments — Track.id IS the post id (see toTrack), so the
          player can ask for them directly.
          Sits in the clear middle band the scrim deliberately leaves open, well
          above the waveform and below the artwork's top third, so it crosses the
          picture rather than the controls. It rises further here than on a feed
          card because there is far more screen to travel.
          This is the screen whose own comment tells you TIMED comments are not
          here; these are not those — no position is claimed, they are simply the
          best comments on the track, drifting. */}
      <FloatingComments
        postId={currentTrack?.id}
        max={3}
        travel={210}
        style={{ left: SPACING.lg, right: SPACING.lg, bottom: SH * 0.34, height: 230 }}
      />

      <View style={[styles.header, { paddingTop: insets.top + SPACING.sm }]}>
        <TouchableOpacity onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('a11y.back')}>
          <Ionicons name="chevron-down" size={30} color="#fff" />
        </TouchableOpacity>
      </View>

      <View style={[styles.foot, { paddingBottom: insets.bottom + SPACING.lg }]}>
        <Text style={styles.title} numberOfLines={2}>{currentTrack.caption || t('player.audioTrack')}</Text>
        <Text style={styles.artist} numberOfLines={1}>{currentTrack.artist}</Text>

        {/* Waveform. Two identical bar rows: a dim one always visible, and a
            bright one clipped by a sliding mask — the same native-driver reveal
            Scrubber uses, so scrubbing a 68-bar row costs no JS per frame. */}
        <View
          ref={wrapRef}
          // Re-measured on every layout, and the WIDTH is captured too — the
          // handlers cannot read either from render scope, so both have to be
          // refs. A stale x is a drag that lands in the wrong place.
          onLayout={() => wrapRef.current?.measureInWindow((x, _y, w) => { wrapX.current = x; wrapW.current = w || trackW; })}
          style={[styles.wave, { width: trackW }]}
          {...pan.panHandlers}
        >
          <Row bars={bars} barW={barW} color="rgba(255,255,255,0.28)" />
          <Animated.View
            style={[
              StyleSheet.absoluteFill,
              { overflow: 'hidden', transform: [{ translateX: prog.interpolate({ inputRange: [0, 1], outputRange: [-trackW, 0] }) }] },
            ]}
          >
            <Animated.View style={{ transform: [{ translateX: prog.interpolate({ inputRange: [0, 1], outputRange: [trackW, 0] }) }] }}>
              <Row bars={bars} barW={barW} color="#FFFFFF" />
            </Animated.View>
          </Animated.View>
        </View>

        <View style={styles.times}>
          <Text style={styles.time}>{fmt(playedMs)}</Text>
          <Text style={styles.time}>{durationMs > 0 ? fmt(durationMs) : '--:--'}</Text>
        </View>

        <View style={styles.controls}>
          <TouchableOpacity onPress={previous} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('a11y.prevTrack')}>
            <Ionicons name="play-skip-back" size={26} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => (isPlaying ? pause() : resume())}
            style={styles.playBtn}
            accessibilityRole="button"
            accessibilityLabel={isPlaying ? t('a11y.pause') : t('a11y.play')}
          >
            <Ionicons name={isPlaying ? 'pause' : 'play'} size={30} color="#111" style={!isPlaying && { marginLeft: 3 }} />
          </TouchableOpacity>
          <TouchableOpacity onPress={next} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('a11y.nextTrack')}>
            <Ionicons name="play-skip-forward" size={26} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>
    </Animated.View>
  );
}

// ── Floating notes ───────────────────────────────────────────────────────────
// Musical notes drift up out of the BOTTOM-RIGHT CORNER while the song plays, so
// the screen reads as something happening rather than a still image with audio
// behind it.
//
// Deliberately penned into a small corner: the artwork is the whole point of
// this screen, and notes wandering across it were covering the thing you came to
// look at. They rise a short way out of the corner above the transport and stop.
//
// One Animated.Value per note, all on the native driver, so the whole effect
// costs nothing on the JS thread — it has to survive scrubbing and a panning
// full-screen image at the same time.
//
// The layer is visible only while the song is actually PLAYING — a paused song
// with notes still rising would be saying the opposite of the truth. It unmounts
// with the screen, so nothing animates behind a closed player.
const NOTE_COUNT = 4;
const NOTE_GLYPHS = ['musical-note', 'musical-notes'] as const;
// A near-vertical COLUMN, not a spread. The x positions vary by about ten
// pixels in total — enough that the notes are not stacked on one pixel like a
// conveyor belt, little enough that the eye reads a single rising line. There is
// no sideways drift at all; the wander is what made them feel like they were
// taking over the artwork.
const NOTE_X_MIN = 0.845;
const NOTE_X_SPAN = 0.035;
const NOTE_BOTTOM = 0.34;
const NOTE_RISE = 0.17;
// Faint on purpose. This sits under the scrim, which eats about a third of it,
// so what actually lands on screen is around a quarter opacity — a suggestion of
// movement in the corner rather than something you look at.
const NOTE_PEAK = 0.4;
// Each note is invisible for the last 40% of its cycle. Without that dead time
// four notes on a ~5s loop are all in flight at once and a single column becomes
// a continuous stream; the gap keeps it to two or three, arriving irregularly.
const NOTE_LIFE = 0.6;

function FloatingNotes({ playing, w, h }: { playing: boolean; w: number; h: number }) {
  // Pausing has to STOP the notes, but stopping a loop leaves every note frozen
  // in mid-air at whatever opacity it happened to be — a stuck screen, which is
  // the opposite of what this effect is for. So the whole layer fades out first
  // and the loops keep turning behind it: nine native-driver timings cost
  // essentially nothing, and resuming picks up in phase instead of snapping
  // everything back to the bottom of the screen at once.
  const gate = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(gate, {
      toValue: playing ? 1 : 0,
      duration: playing ? 600 : 420,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [playing, gate]);

  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: gate }]}>
      {Array.from({ length: NOTE_COUNT }).map((_, i) => (
        <FloatingNote key={i} index={i} w={w} h={h} />
      ))}
    </Animated.View>
  );
}

function FloatingNote({ index, w, h }: { index: number; w: number; h: number }) {
  const t = useRef(new Animated.Value(0)).current;

  // Everything about a note is derived from its index, so the drift is varied
  // but stable — no Math.random, which would reshuffle on every re-render and
  // make notes visibly jump.
  const f = (index * 2654435761) % 1000 / 1000;      // 0..1, well spread
  const g = (index * 40503) % 997 / 997;
  const startX = NOTE_X_MIN + NOTE_X_SPAN * f;        // fraction of the width
  const dur = 4600 + Math.round(2200 * g);            // 4.6s–6.8s
  // Flat stagger, NOT one scaled to this note's duration — scaling it meant the
  // slowest note also waited longest, and the corner took seven seconds to fill.
  const delay = index * 1100;
  const size = 11 + Math.round(5 * f);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(t, { toValue: 1, duration: dur, easing: Easing.linear, useNativeDriver: true }),
    );
    // Staggered by a timer rather than an Animated.delay inside the loop: a delay
    // inside would repeat every cycle and leave a gap, where this offsets each
    // note once and then they run continuously.
    const kick = setTimeout(() => loop.start(), delay);
    return () => { clearTimeout(kick); loop.stop(); };
  }, [t, dur, delay]);

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: startX * w,
        bottom: h * NOTE_BOTTOM,
        // Fades in, holds, and is gone by NOTE_LIFE — the rest of the cycle is
        // the gap. The rise finishes at the same instant, so nothing is moving
        // while it is invisible and the restart at the bottom is never seen.
        opacity: t.interpolate({
          inputRange: [0, NOTE_LIFE * 0.22, NOTE_LIFE * 0.66, NOTE_LIFE, 1],
          outputRange: [0, NOTE_PEAK, NOTE_PEAK * 0.85, 0, 0],
        }),
        transform: [
          { translateY: t.interpolate({ inputRange: [0, NOTE_LIFE, 1], outputRange: [0, -h * NOTE_RISE, -h * NOTE_RISE] }) },
          // No translateX. A straight rise is the whole point — any sway at all
          // and four notes stop reading as one line and start reading as a spread.
          { scale: t.interpolate({ inputRange: [0, NOTE_LIFE * 0.3, 1], outputRange: [0.82, 1, 1] }) },
          { rotate: t.interpolate({ inputRange: [0, 1], outputRange: ['-5deg', '5deg'] }) },
        ],
      }}
    >
      <Ionicons name={NOTE_GLYPHS[index % NOTE_GLYPHS.length]} size={size} color="#fff" />
    </Animated.View>
  );
}

// Pulled out so the 68 bars are one memo-able element rather than rebuilt inside
// two separate render paths.
function Row({ bars, barW, color }: { bars: number[]; barW: number; color: string }) {
  return (
    <View style={rowStyles.row} pointerEvents="none">
      {bars.map((h, i) => (
        <View
          key={i}
          style={{
            width: barW, height: `${Math.round(h * 100)}%`,
            marginRight: i === bars.length - 1 ? 0 : BAR_GAP,
            backgroundColor: color, borderRadius: 1,
          }}
        />
      ))}
    </View>
  );
}

const rowStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', height: '100%' },
});

const makeStyles = (_c: ThemePalette) => StyleSheet.create({
  // Always dark regardless of theme: this is a full-bleed image with white text
  // over it, so the theme's light surfaces have nothing to do here.
  root: { backgroundColor: '#000', zIndex: 60 },
  header: { paddingHorizontal: SPACING.lg },
  foot: { marginTop: 'auto', paddingHorizontal: SPACING.lg, gap: 2 },
  title: { color: '#fff', fontSize: 26, fontWeight: '900', letterSpacing: -0.4 },
  artist: { color: 'rgba(255,255,255,0.78)', fontSize: 15, fontWeight: '600', marginBottom: SPACING.md },
  wave: { height: 56, justifyContent: 'center' },
  times: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  time: { color: 'rgba(255,255,255,0.7)', fontSize: 12, fontVariant: ['tabular-nums'] },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.xl, marginTop: SPACING.md },
  playBtn: {
    width: 62, height: 62, borderRadius: 31, backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
  },
});
