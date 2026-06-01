import { View, Text, TouchableOpacity, StyleSheet, Image, PanResponder } from 'react-native';
import { useRef, useState } from 'react';
import { useRouter, usePathname } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useAudio } from '../contexts/AudioContext';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../constants/theme';
import { Ionicons } from '@expo/vector-icons';

const THUMB = 14;

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export default function MiniPlayer() {
  const { currentTrack, isPlaying, isBuffering, positionMs, durationMs, pause, resume, stop, seekTo } = useAudio();
  const router = useRouter();
  const pathname = usePathname();
  const [barWidth, setBarWidth] = useState(0);
  const [dragRatio, setDragRatio] = useState<number | null>(null);

  // Refs so the once-created PanResponder always sees fresh values.
  const barWidthRef = useRef(0);
  const durationRef = useRef(0);
  const seekRef = useRef(seekTo);
  durationRef.current = durationMs;
  seekRef.current = seekTo;

  const clamp = (n: number) => Math.max(0, Math.min(1, n));

  const commitSeek = (locationX: number) => {
    const r = clamp(locationX / (barWidthRef.current || 1));
    if (durationRef.current) seekRef.current(Math.floor(r * durationRef.current));
    setDragRatio(null);
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false, // keep the gesture; don't snap back
      onPanResponderGrant: e => setDragRatio(clamp(e.nativeEvent.locationX / (barWidthRef.current || 1))),
      onPanResponderMove: e => setDragRatio(clamp(e.nativeEvent.locationX / (barWidthRef.current || 1))),
      onPanResponderRelease: e => commitSeek(e.nativeEvent.locationX),
      onPanResponderTerminate: e => commitSeek(e.nativeEvent.locationX),
    })
  ).current;

  if (!currentTrack || pathname === '/now-playing') return null;

  const progress = durationMs > 0 ? positionMs / durationMs : 0;
  const shown = dragRatio != null ? dragRatio : progress;

  return (
    <View style={styles.container}>
      {/* Scrubbable progress bar with draggable thumb */}
      <View
        style={styles.progressArea}
        onLayout={e => { const w = e.nativeEvent.layout.width; setBarWidth(w); barWidthRef.current = w; }}
        {...panResponder.panHandlers}
      >
        <View style={styles.progressTrack}>
          <LinearGradient
            colors={GRADIENTS.primaryWarm}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
            style={[styles.progressFill, { width: `${shown * 100}%` }]}
          />
        </View>
        <View style={[styles.thumb, { left: Math.max(0, Math.min(barWidth - THUMB, shown * barWidth - THUMB / 2)) }]} />
      </View>

      <View style={styles.inner}>
        {/* Album cover — tap to open the full now-playing screen */}
        <TouchableOpacity style={styles.coverWrap} onPress={() => router.push('/now-playing')}>
          {currentTrack.cover ? (
            <Image source={{ uri: currentTrack.cover }} style={styles.cover} />
          ) : (
            <LinearGradient colors={GRADIENTS.primarySoft} style={styles.cover}>
              <Ionicons name="musical-notes" size={16} color={COLORS.primary} />
            </LinearGradient>
          )}
        </TouchableOpacity>

        {/* Tapping anywhere else on the bar toggles play/pause */}
        <TouchableOpacity style={styles.body} activeOpacity={0.7} onPress={() => (isPlaying ? pause() : resume())}>
          <View style={styles.trackInfo}>
            <Text style={styles.caption} numberOfLines={1}>{currentTrack.caption || 'Audio Track'}</Text>
            <Text style={styles.artist} numberOfLines={1}>{currentTrack.artist}</Text>
          </View>
          <Text style={styles.timeText}>
            {formatMs(positionMs)}{durationMs > 0 ? ` / ${formatMs(durationMs)}` : ''}
          </Text>
          <View style={styles.playBtn}>
            <Ionicons name={isBuffering ? 'hourglass' : isPlaying ? 'pause' : 'play'} size={15} color={COLORS.text} />
          </View>
        </TouchableOpacity>

        <TouchableOpacity style={styles.stopBtn} onPress={stop}>
          <Ionicons name="close" size={15} color={COLORS.textSecondary} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute', bottom: 60, left: 0, right: 0,
    backgroundColor: COLORS.surface,
    borderTopWidth: 0.5, borderTopColor: COLORS.primaryLight + '66',
    zIndex: 100,
  },
  progressArea: { height: 16, justifyContent: 'center', width: '100%' },
  progressTrack: { height: 4, backgroundColor: COLORS.border, width: '100%' },
  progressFill: { height: '100%', backgroundColor: COLORS.primary },
  thumb: {
    position: 'absolute', top: (16 - THUMB) / 2,
    width: THUMB, height: THUMB, borderRadius: THUMB / 2,
    backgroundColor: COLORS.primary, borderWidth: 2, borderColor: COLORS.text,
  },
  inner: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, gap: SPACING.sm,
  },
  coverWrap: { width: 38, height: 38, borderRadius: RADIUS.sm, overflow: 'hidden' },
  cover: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  trackInfo: { flex: 1 },
  caption: { color: COLORS.text, fontSize: 13, fontWeight: '600' },
  artist: { color: COLORS.textSecondary, fontSize: 11, marginTop: 1 },
  timeText: { color: COLORS.textTertiary, fontSize: 11, fontVariant: ['tabular-nums'] },
  playBtn: {
    width: 32, height: 32, borderRadius: RADIUS.full,
    backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center',
  },
  stopBtn: {
    width: 30, height: 30, borderRadius: RADIUS.full,
    backgroundColor: COLORS.surfaceElevated, alignItems: 'center', justifyContent: 'center',
  },
});
