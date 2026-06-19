import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { formatCount } from '../lib/format';
import { guardPress } from '../contexts/PagerContext';
import HighlightText from './HighlightText';
import BadgeEmblem from './BadgeEmblem';
import { type ProfileBadgeFields } from '../lib/badges';

function formatDuration(seconds?: number | null) {
  if (!seconds || seconds <= 0) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function TrackRow({
  caption, artist, username, duration, streams, cover, avatarUrl, badgeProfile, badgeOwnerId,
  isPlaying, onPlay, onCoverPress, onAddToPlaylist, onAvatarPress, onOptions, hidePlayButton, highlightQuery, spotlighted,
}: {
  caption: string; artist: string; username: string; duration?: number | null; streams?: number;
  cover?: string | null; avatarUrl?: string | null; hidePlayButton?: boolean;
  // The track owner's badge fields + id, so their emblem shows next to the handle
  // and tapping your own opens your Badges page.
  badgeProfile?: ProfileBadgeFields | null;
  badgeOwnerId?: string | null;
  // When true, a subtle yellow sparkle shows by the handle — the track has a live
  // spotlight (publicly visible to everyone while the campaign runs).
  spotlighted?: boolean;
  isPlaying: boolean; onPlay: () => void; onCoverPress?: () => void; onAddToPlaylist?: () => void; onAvatarPress?: () => void;
  // When provided (i.e. the track belongs to the current user), long-pressing the
  // row triggers it — used app-wide for "delete my post".
  onOptions?: () => void;
  // When set (search results), matches in the caption + handle are highlighted.
  highlightQuery?: string;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const durationLabel = formatDuration(duration);
  // Swipe-tap guard: a tab swipe gliding over the row must not start playback
  // or open a profile (presses during/just after a swipe are swallowed).
  const safePlay = guardPress(onPlay)!;
  const safeCover = guardPress(onCoverPress ?? onPlay)!;
  const safeAdd = guardPress(onAddToPlaylist);
  const safeAvatar = guardPress(onAvatarPress);
  return (
    <LinearGradient
      colors={isPlaying ? GRADIENTS.primarySoft : GRADIENTS.card}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.row, isPlaying && styles.rowActive]}
    >
      {/* Cover art (left) — tap to expand to the now-playing screen.
          Long-press opens the options sheet from ANY part of the row. */}
      <TouchableOpacity style={styles.coverWrap} onPress={safeCover} onLongPress={onOptions}>
        {cover ? (
          <Image source={{ uri: cover }} style={styles.cover} />
        ) : (
          <LinearGradient colors={GRADIENTS.primarySoft} style={styles.cover}>
            <Ionicons name="musical-notes" size={18} color={colors.primary} />
          </LinearGradient>
        )}
        {isPlaying && (
          <View style={styles.coverOverlayActive}>
            <Ionicons name="musical-notes" size={16} color={colors.text} />
          </View>
        )}
      </TouchableOpacity>

      {/* Track outline — tap to play/pause, long-press for options (own tracks) */}
      <TouchableOpacity style={styles.info} activeOpacity={0.7} onPress={safePlay} onLongPress={onOptions}>
        <HighlightText text={caption || 'Audio Track'} query={highlightQuery} style={styles.caption} highlightStyle={styles.hl} numberOfLines={1} />
        <View style={styles.meta}>
          <HighlightText text={`@${username}`} query={highlightQuery} style={styles.artist} highlightStyle={styles.hl} numberOfLines={1} />
          <BadgeEmblem profile={badgeProfile} ownerId={badgeOwnerId} size={11} />
          {spotlighted && <Ionicons name="sparkles" size={11} color={colors.primaryLight} />}
          <Ionicons name="play" size={9} color={colors.textTertiary} />
          <Text style={styles.streams}>{formatCount(streams)}</Text>
          {durationLabel && <Text style={styles.artist}>· {durationLabel}</Text>}
        </View>
      </TouchableOpacity>

      {/* Play / pause — borderless filled-circle glyph, same as Today's Pick */}
      {!hidePlayButton && (
        <TouchableOpacity onPress={safePlay} onLongPress={onOptions} activeOpacity={0.8} hitSlop={6}>
          <Ionicons name={isPlaying ? 'pause-circle' : 'play-circle'} size={44} color={colors.primary} />
        </TouchableOpacity>
      )}

      {onAddToPlaylist && (
        <TouchableOpacity style={styles.addBtn} onPress={safeAdd} onLongPress={onOptions}>
          <Ionicons name="add-circle-outline" size={22} color={colors.primary} />
        </TouchableOpacity>
      )}

      {/* Artist avatar (right) — tap to open profile */}
      {onAvatarPress && (
        <TouchableOpacity onPress={safeAvatar} onLongPress={onOptions}>
          {avatarUrl ? (
            <Image source={{ uri: avatarUrl }} style={styles.avatar} />
          ) : (
            <LinearGradient colors={GRADIENTS.primary} style={styles.avatar}>
              <Text style={styles.avatarText}>{(artist || username || '?').charAt(0).toUpperCase()}</Text>
            </LinearGradient>
          )}
        </TouchableOpacity>
      )}
    </LinearGradient>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center',
    borderRadius: RADIUS.lg,
    padding: SPACING.md, borderWidth: 1, borderColor: colors.border, gap: SPACING.md,
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  rowActive: { borderColor: colors.primary + '55' },
  coverWrap: {
    width: 50, height: 50, borderRadius: RADIUS.md, overflow: 'hidden',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)',
  },
  cover: { width: 50, height: 50, borderRadius: RADIUS.md, alignItems: 'center', justifyContent: 'center' },
  coverOverlayActive: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(224,64,28,0.5)',
  },
  info: { flex: 1 },
  caption: { color: colors.text, fontSize: 14, fontWeight: '700' },
  hl: { color: colors.primary, fontWeight: '800' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  artist: { color: colors.textSecondary, fontSize: 12 },
  streams: { color: colors.textTertiary, fontSize: 12 },
  addBtn: { padding: SPACING.xs },
  avatar: { width: 34, height: 34, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceElevated },
  avatarText: { color: colors.text, fontSize: 14, fontWeight: '700' },
});
