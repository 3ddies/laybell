import { View, Text, TouchableOpacity, StyleSheet, Image, Animated } from 'react-native';
import { useEffect, useRef, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useAudio, useAudioPosition } from '../contexts/AudioContext';
import { useListenMode } from '../contexts/ListenModeContext';
import { SPACING, RADIUS, GRADIENTS, SHADOWS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { Ionicons } from '@expo/vector-icons';
import Scrubber from './Scrubber';

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// 'bar'     — the normal bottom-docked player.
// 'compact' — Create tab: small top-right card (1.5s dwell, per spec).
// 'side'    — story camera: simplified right-edge chip (cover + play/pause
//             only) so the viewfinder stays clear while the song rides along.
type PlayerVariant = 'bar' | 'compact' | 'side';

export default function MiniPlayer({ variant = 'bar' }: { variant?: PlayerVariant }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { currentTrack, isPlaying, isBuffering, pause, resume, stop, seekTo, expanded, expand } = useAudio();
  const { positionMs, durationMs } = useAudioPosition(); // tick subscription (4×/sec) — small tree, cheap
  const insets = useSafeAreaInsets();
  const { listenMode } = useListenMode();

  // Listen mode: the tab bar fades away, so the player glides down into the
  // space it vacated (the 68px bar height), staying flush above the home bar.
  // Hooks run before the early return below, so the value stays mounted.
  const listenSlide = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(listenSlide, {
      toValue: listenMode ? 68 : 0,
      duration: 350,
      useNativeDriver: true,
    }).start();
  }, [listenMode, listenSlide]);

  // Overlay variants (Create tab card / camera side chip): the player waits
  // out a short dwell on the tab before fading in — a quick swipe-through
  // never flashes it; leaving the tab resets the dwell. The Create card keeps
  // its spec'd 1.5s; the camera chip arrives quicker.
  const isBar = variant === 'bar';
  const compactAnim = useRef(new Animated.Value(0)).current;
  const [overlayReady, setOverlayReady] = useState(false);
  useEffect(() => {
    if (!isBar) {
      compactAnim.setValue(0);
      const t = setTimeout(() => {
        setOverlayReady(true);
        Animated.timing(compactAnim, { toValue: 1, duration: 350, useNativeDriver: true }).start();
      }, variant === 'compact' ? 1500 : 600);
      return () => clearTimeout(t);
    }
    setOverlayReady(false);
    compactAnim.setValue(0);
  }, [variant, isBar, compactAnim]);

  // The BOTTOM BAR fades out/in as the variant flips instead of hard
  // unmounting — rapid swipes across the Create/camera tabs used to make it
  // vanish and pop back instantly, which read as a glitch.
  const barFade = useRef(new Animated.Value(isBar ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(barFade, {
      toValue: isBar ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [isBar, barFade]);

  if (!currentTrack || expanded) return null;

  // Camera side chip — minimal: cover (tap to open the full player) and
  // play/pause. No title, no scrubber, no close — the camera stays the focus.
  if (variant === 'side' && overlayReady) {
    return (
      <Animated.View
        style={[
          styles.sideChip,
          {
            opacity: compactAnim,
            transform: [{ translateX: compactAnim.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
          },
        ]}
      >
        <TouchableOpacity style={styles.compactCoverWrap} onPress={() => expand()}>
          {currentTrack.cover ? (
            <Image source={{ uri: currentTrack.cover }} style={styles.compactCover} />
          ) : (
            <LinearGradient colors={GRADIENTS.primarySoft} style={styles.compactCover}>
              <Ionicons name="musical-notes" size={13} color={colors.primary} />
            </LinearGradient>
          )}
        </TouchableOpacity>
        <TouchableOpacity onPress={() => (isPlaying ? pause() : resume())} hitSlop={8}>
          <Ionicons
            name={isBuffering ? 'hourglass' : isPlaying ? 'pause-circle' : 'play-circle'}
            size={28} color={colors.primary}
          />
        </TouchableOpacity>
        <TouchableOpacity style={styles.compactClose} onPress={stop} hitSlop={8}>
          <Ionicons name="close" size={13} color={colors.textSecondary} />
        </TouchableOpacity>
      </Animated.View>
    );
  }

  if (variant === 'compact' && overlayReady) {
    return (
      <Animated.View
        style={[
          styles.compactCard,
          {
            top: insets.top + 54, // just below the "New post" header row
            opacity: compactAnim,
            transform: [{ translateY: compactAnim.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }],
          },
        ]}
      >
        <TouchableOpacity style={styles.compactCoverWrap} onPress={() => expand()}>
          {currentTrack.cover ? (
            <Image source={{ uri: currentTrack.cover }} style={styles.compactCover} />
          ) : (
            <LinearGradient colors={GRADIENTS.primarySoft} style={styles.compactCover}>
              <Ionicons name="musical-notes" size={13} color={colors.primary} />
            </LinearGradient>
          )}
        </TouchableOpacity>
        <TouchableOpacity style={styles.compactBody} activeOpacity={0.7} onPress={() => expand()}>
          <Text style={styles.compactTitle} numberOfLines={1}>{currentTrack.caption || 'Audio Track'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.compactBtn} onPress={() => (isPlaying ? pause() : resume())} hitSlop={6}>
          <Ionicons
            name={isBuffering ? 'hourglass' : isPlaying ? 'pause-circle' : 'play-circle'}
            size={26} color={colors.primary}
          />
        </TouchableOpacity>
        <TouchableOpacity style={styles.compactClose} onPress={stop} hitSlop={6}>
          <Ionicons name="close" size={13} color={colors.textSecondary} />
        </TouchableOpacity>
      </Animated.View>
    );
  }

  // Sit just above the tab bar (68 + bottom inset), clearing the ~4px the center
  // "+" button now protrudes above it (its pop-up was reduced in the tab bar).
  const bottomOffset = 68 + insets.bottom + 6;

  const progress = durationMs > 0 ? positionMs / durationMs : 0;

  // Rendered in bar mode AND during an overlay dwell (fading out via barFade)
  // — never hard-removed on a tab flip, so fast swipes look smooth.
  return (
    <Animated.View
      pointerEvents={isBar ? 'auto' : 'none'}
      style={[styles.container, { bottom: bottomOffset, opacity: barFade, transform: [{ translateY: listenSlide }] }]}
    >
      <View style={styles.scrubWrap}>
        <Scrubber
          progress={progress}
          onSeek={r => durationMs > 0 && seekTo(Math.floor(r * durationMs))}
          height={16} trackHeight={4} thumbSize={12}
        />
      </View>

      <View style={styles.inner}>
        {/* Album cover — tap to open the full now-playing screen */}
        <TouchableOpacity style={styles.coverWrap} onPress={() => expand()}>
          {currentTrack.cover ? (
            <Image source={{ uri: currentTrack.cover }} style={styles.cover} />
          ) : (
            <LinearGradient colors={GRADIENTS.primarySoft} style={styles.cover}>
              <Ionicons name="musical-notes" size={16} color={colors.primary} />
            </LinearGradient>
          )}
        </TouchableOpacity>

        {/* Tapping the bar (except the controls) expands the now-playing screen */}
        <TouchableOpacity style={styles.body} activeOpacity={0.7} onPress={() => expand()}>
          <View style={styles.trackInfo}>
            <Text style={styles.caption} numberOfLines={1}>{currentTrack.caption || 'Audio Track'}</Text>
            <Text style={styles.artist} numberOfLines={1}>{currentTrack.artist}</Text>
          </View>
          <Text style={styles.timeText}>
            {formatMs(positionMs)}{durationMs > 0 ? ` / ${formatMs(durationMs)}` : ''}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.playBtn} onPress={() => (isPlaying ? pause() : resume())}>
          {isBuffering ? (
            <Ionicons name="hourglass" size={18} color={colors.primary} />
          ) : (
            <Ionicons name={isPlaying ? 'pause-circle' : 'play-circle'} size={34} color={colors.primary} />
          )}
        </TouchableOpacity>

        <TouchableOpacity style={styles.stopBtn} onPress={stop}>
          <Ionicons name="close" size={15} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: {
    position: 'absolute', left: SPACING.sm, right: SPACING.sm,
    backgroundColor: colors.surfaceElevated,
    borderRadius: RADIUS.lg, overflow: 'hidden',
    borderWidth: 0.5, borderColor: colors.primaryLight + '55',
    ...SHADOWS.md,
    zIndex: 100,
  },
  scrubWrap: { paddingHorizontal: SPACING.sm, paddingTop: SPACING.xs },
  inner: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm, paddingTop: SPACING.xs, gap: SPACING.sm,
  },
  coverWrap: { width: 38, height: 38, borderRadius: RADIUS.sm, overflow: 'hidden' },
  cover: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  trackInfo: { flex: 1 },
  caption: { color: colors.text, fontSize: 13, fontWeight: '600' },
  artist: { color: colors.textSecondary, fontSize: 11, marginTop: 1 },
  timeText: { color: colors.textTertiary, fontSize: 11, fontVariant: ['tabular-nums'] },
  // Borderless filled-circle glyph (same as Today's Pick) — fixed box keeps
  // the bar layout stable between the play/pause/buffering states.
  playBtn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  stopBtn: {
    width: 30, height: 30, borderRadius: RADIUS.full,
    backgroundColor: colors.surfaceElevated, alignItems: 'center', justifyContent: 'center',
  },

  // ── Compact card (Create tab) — small pill pinned top-right, below the
  // "New post" header so it never covers the Next arrow. ──
  compactCard: {
    position: 'absolute', right: SPACING.sm, maxWidth: 210,
    flexDirection: 'row', alignItems: 'center', gap: SPACING.xs + 2,
    backgroundColor: colors.surfaceElevated,
    borderRadius: RADIUS.full,
    borderWidth: 0.5, borderColor: colors.primaryLight + '55',
    paddingVertical: 5, paddingLeft: 5, paddingRight: SPACING.sm,
    ...SHADOWS.md,
    zIndex: 100,
  },
  compactCoverWrap: { width: 28, height: 28, borderRadius: 14, overflow: 'hidden' },
  compactCover: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  compactBody: { flexShrink: 1, maxWidth: 96 },
  compactTitle: { color: colors.text, fontSize: 12, fontWeight: '600' },
  compactBtn: { alignItems: 'center', justifyContent: 'center' },
  compactClose: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: colors.surfaceLight, alignItems: 'center', justifyContent: 'center',
  },

  // ── Side chip (story camera) — vertical pill hugging the right edge at
  // mid-height, clear of the top camera controls and the bottom shutter. ──
  sideChip: {
    position: 'absolute', right: 8, top: '42%',
    alignItems: 'center', gap: 8,
    backgroundColor: colors.surfaceElevated,
    borderRadius: RADIUS.full,
    borderWidth: 0.5, borderColor: colors.primaryLight + '55',
    paddingVertical: 8, paddingHorizontal: 6,
    ...SHADOWS.md,
    zIndex: 100,
  },
});
