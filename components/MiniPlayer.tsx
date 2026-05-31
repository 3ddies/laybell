import { View, Text, TouchableOpacity, StyleSheet, Pressable } from 'react-native';
import { useRef, useState } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { useAudio } from '../contexts/AudioContext';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../constants/theme';
import { Ionicons } from '@expo/vector-icons';

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export default function MiniPlayer() {
  const { currentTrack, isPlaying, isBuffering, positionMs, durationMs, stop, seekTo } = useAudio();
  const [barWidth, setBarWidth] = useState(0);

  if (!currentTrack) return null;

  const progress = durationMs > 0 ? positionMs / durationMs : 0;

  function handleSeek(evt: any) {
    if (!barWidth || !durationMs) return;
    const x = evt.nativeEvent.locationX;
    const ratio = Math.max(0, Math.min(1, x / barWidth));
    seekTo(Math.floor(ratio * durationMs));
  }

  return (
    <View style={styles.container}>
      {/* Seekable progress bar */}
      <Pressable
        style={styles.progressTrack}
        onLayout={e => setBarWidth(e.nativeEvent.layout.width)}
        onPress={handleSeek}
      >
        <LinearGradient
          colors={GRADIENTS.primaryWarm}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={[styles.progressFill, { width: `${progress * 100}%` }]}
        />
      </Pressable>

      <View style={styles.inner}>
        <View style={styles.iconWrap}>
          {isBuffering ? (
            <Text style={styles.bufferingDot}>⟳</Text>
          ) : (
            <Text style={styles.icon}>🎵</Text>
          )}
        </View>

        <View style={styles.trackInfo}>
          <Text style={styles.caption} numberOfLines={1}>
            {currentTrack.caption || 'Audio Track'}
          </Text>
          <Text style={styles.artist} numberOfLines={1}>
            {currentTrack.artist}
          </Text>
        </View>

        <View style={styles.controls}>
          <Text style={styles.timeText}>
            {formatMs(positionMs)}
            {durationMs > 0 ? ` / ${formatMs(durationMs)}` : ''}
          </Text>
          <TouchableOpacity style={styles.stopBtn} onPress={stop}>
            <Ionicons name="stop" size={14} color={COLORS.text} />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 60,
    left: 0,
    right: 0,
    backgroundColor: COLORS.surface,
    borderTopWidth: 0.5,
    borderTopColor: COLORS.primaryLight + '66',
    zIndex: 100,
  },
  progressTrack: {
    height: 3,
    backgroundColor: COLORS.border,
    width: '100%',
  },
  progressFill: {
    height: '100%',
    backgroundColor: COLORS.primary,
    borderRadius: 2,
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    gap: SPACING.sm,
  },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: RADIUS.sm,
    backgroundColor: COLORS.primary + '33',
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: { fontSize: 16 },
  bufferingDot: {
    fontSize: 18,
    color: COLORS.primary,
  },
  trackInfo: {
    flex: 1,
  },
  caption: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '600',
  },
  artist: {
    color: COLORS.textSecondary,
    fontSize: 11,
    marginTop: 1,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  timeText: {
    color: COLORS.textTertiary,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  stopBtn: {
    width: 30,
    height: 30,
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
