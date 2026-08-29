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
  const ratioAt = (pageX: number) => Math.max(0, Math.min(1, (pageX - wrapX.current) / (trackW || 1)));

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
        if (durationMs > 0) seekTo(Math.floor(r * durationMs));
      },
      onPanResponderTerminate: () => { dragging.current = false; setDragRatio(null); },
    }),
  ).current;

  if (!mounted || !currentTrack) return null;

  // The cover is rendered WIDER than the screen and slid left as the song plays.
  // 1.55× gives a pan long enough to be felt over a three-minute track without
  // the crop throwing away most of the artwork.
  const artW = SW * 1.55;
  const panX = prog.interpolate({ inputRange: [0, 1], outputRange: [0, -(artW - SW)] });
  const playedMs = dragRatio != null ? dragRatio * durationMs : positionMs;

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.root, { opacity: enter }]}>
      {/* Background: the artwork itself, panning. */}
      <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ translateX: panX }] }]}>
        {currentTrack.cover ? (
          <ExpoImage
            source={{ uri: currentTrack.cover }}
            style={{ width: artW, height: SH }}
            contentFit="cover"
            cachePolicy="memory-disk"
          />
        ) : (
          <View style={{ width: artW, height: SH, backgroundColor: '#111' }} />
        )}
      </Animated.View>
      {/* Legibility scrim. Heavier at top and bottom, where all the text is —
          the middle stays clear so the artwork is actually visible, which is the
          entire point of the screen. */}
      <LinearGradient
        colors={['rgba(0,0,0,0.72)', 'rgba(0,0,0,0.18)', 'rgba(0,0,0,0.30)', 'rgba(0,0,0,0.88)']}
        locations={[0, 0.34, 0.58, 1]}
        style={StyleSheet.absoluteFill}
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
          onLayout={() => wrapRef.current?.measureInWindow((x) => { wrapX.current = x; })}
          style={[styles.wave, { width: trackW }]}
          {...pan.panHandlers}
        >
          <Row bars={bars} barW={barW} color="rgba(255,255,255,0.34)" />
          <Animated.View
            style={[
              StyleSheet.absoluteFill,
              { overflow: 'hidden', transform: [{ translateX: prog.interpolate({ inputRange: [0, 1], outputRange: [-trackW, 0] }) }] },
            ]}
          >
            <Animated.View style={{ transform: [{ translateX: prog.interpolate({ inputRange: [0, 1], outputRange: [trackW, 0] }) }] }}>
              <Row bars={bars} barW={barW} color="#F26522" />
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
