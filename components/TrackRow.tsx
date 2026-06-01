import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../constants/theme';
import { formatCount } from '../lib/format';

function formatDuration(seconds?: number | null) {
  if (!seconds || seconds <= 0) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function TrackRow({
  caption, artist, username, duration, streams, cover, avatarUrl,
  isPlaying, onPlay, onCoverPress, onAddToPlaylist, onAvatarPress,
}: {
  caption: string; artist: string; username: string; duration?: number | null; streams?: number;
  cover?: string | null; avatarUrl?: string | null;
  isPlaying: boolean; onPlay: () => void; onCoverPress?: () => void; onAddToPlaylist?: () => void; onAvatarPress?: () => void;
}) {
  const durationLabel = formatDuration(duration);
  return (
    <View style={styles.row}>
      {/* Cover art (left) — tap to expand to the now-playing screen */}
      <TouchableOpacity style={styles.coverWrap} onPress={onCoverPress ?? onPlay}>
        {cover ? (
          <Image source={{ uri: cover }} style={styles.cover} />
        ) : (
          <LinearGradient colors={GRADIENTS.primarySoft} style={styles.cover}>
            <Ionicons name="musical-notes" size={18} color={COLORS.primary} />
          </LinearGradient>
        )}
        {isPlaying && (
          <View style={styles.coverOverlayActive}>
            <Ionicons name="musical-notes" size={16} color={COLORS.text} />
          </View>
        )}
      </TouchableOpacity>

      {/* Track outline — tap to play/pause */}
      <TouchableOpacity style={styles.info} activeOpacity={0.7} onPress={onPlay}>
        <Text style={styles.caption} numberOfLines={1}>{caption || 'Audio Track'}</Text>
        <View style={styles.meta}>
          <Text style={styles.artist} numberOfLines={1}>@{username}</Text>
          <Ionicons name="play" size={9} color={COLORS.textTertiary} />
          <Text style={styles.streams}>{formatCount(streams)}</Text>
          {durationLabel && <Text style={styles.artist}>· {durationLabel}</Text>}
        </View>
      </TouchableOpacity>

      {onAddToPlaylist && (
        <TouchableOpacity style={styles.addBtn} onPress={onAddToPlaylist}>
          <Ionicons name="add-circle-outline" size={22} color={COLORS.primary} />
        </TouchableOpacity>
      )}

      {/* Artist avatar (right) — tap to open profile */}
      {onAvatarPress && (
        <TouchableOpacity onPress={onAvatarPress}>
          {avatarUrl ? (
            <Image source={{ uri: avatarUrl }} style={styles.avatar} />
          ) : (
            <LinearGradient colors={GRADIENTS.primary} style={styles.avatar}>
              <Text style={styles.avatarText}>{(artist || username || '?').charAt(0).toUpperCase()}</Text>
            </LinearGradient>
          )}
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: COLORS.surfaceLight, borderRadius: RADIUS.md,
    padding: SPACING.md, borderWidth: 1, borderColor: COLORS.border, gap: SPACING.md,
  },
  coverWrap: { width: 48, height: 48, borderRadius: RADIUS.sm, overflow: 'hidden' },
  cover: { width: 48, height: 48, borderRadius: RADIUS.sm, alignItems: 'center', justifyContent: 'center' },
  coverOverlayActive: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(224,64,28,0.5)',
  },
  info: { flex: 1 },
  caption: { color: COLORS.text, fontSize: 14, fontWeight: '600' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  artist: { color: COLORS.textSecondary, fontSize: 12 },
  streams: { color: COLORS.textTertiary, fontSize: 12 },
  addBtn: { padding: SPACING.xs },
  avatar: { width: 34, height: 34, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.surfaceElevated },
  avatarText: { color: COLORS.text, fontSize: 14, fontWeight: '700' },
});
