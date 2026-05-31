import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useAudio } from '../contexts/AudioContext';
import { COLORS, SPACING, RADIUS } from '../constants/theme';

export default function MiniPlayer() {
  const { currentTrack, isPlaying, stop } = useAudio();

  if (!currentTrack) return null;

  return (
    <View style={styles.container}>
      <View style={styles.progressBar} />
      <View style={styles.inner}>
        <View style={styles.iconWrap}>
          <Text style={styles.icon}>🎵</Text>
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
          {isPlaying && <View style={styles.playingDot} />}
          <TouchableOpacity style={styles.stopBtn} onPress={stop}>
            <Text style={styles.stopIcon}>■</Text>
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
    borderTopColor: COLORS.primary + '66',
    zIndex: 100,
  },
  progressBar: {
    height: 2,
    backgroundColor: COLORS.primary,
    width: '40%',
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    gap: SPACING.sm,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: RADIUS.sm,
    backgroundColor: COLORS.primary + '33',
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: {
    fontSize: 18,
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
  playingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.primary,
  },
  stopBtn: {
    width: 32,
    height: 32,
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopIcon: {
    color: COLORS.text,
    fontSize: 12,
  },
});
