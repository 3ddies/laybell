import { View, Text, TouchableOpacity, StyleSheet, Image } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useAudio } from '../contexts/AudioContext';
import { SPACING, RADIUS, GRADIENTS, SHADOWS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { Ionicons } from '@expo/vector-icons';
import Scrubber from './Scrubber';

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export default function MiniPlayer() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { currentTrack, isPlaying, isBuffering, positionMs, durationMs, pause, resume, stop, seekTo, expanded, expand } = useAudio();
  const insets = useSafeAreaInsets();

  if (!currentTrack || expanded) return null;

  // Sit just above the tab bar (68 + bottom inset), clearing the ~4px the center
  // "+" button now protrudes above it (its pop-up was reduced in the tab bar).
  const bottomOffset = 68 + insets.bottom + 6;

  const progress = durationMs > 0 ? positionMs / durationMs : 0;

  return (
    <View style={[styles.container, { bottom: bottomOffset }]}>
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
    </View>
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
});
