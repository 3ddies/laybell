import { useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { badgeGlow } from '../lib/badges';
import { HIDDEN_NAME } from '../lib/hiddenProfile';
import { useStories } from '../contexts/StoriesContext';

// Drop-in avatar that shows a ring ONLY while `userId` has an active story (the
// story is what surfaces the ring) and opens the story viewer on tap; otherwise it
// falls back to `onPressProfile` and shows no ring. `size` is the OUTER footprint,
// so it occupies the same space as the avatar it replaces (the image shrinks
// slightly to fit a ring, like Instagram). The ring is colored by the user's
// badge tier (resolved globally from StoriesContext for any user with a story);
// pass `badgeRing` to override with specific colors (e.g. a styled profile ring).
// With no badge it uses the default story gradient (unseen) / gray (seen).

type Props = {
  userId?: string | null;
  avatarUrl?: string | null;
  name?: string | null;
  size: number;
  onPressProfile?: () => void;
  onBeforeOpenStory?: () => void; // e.g. close an overlay before pushing the viewer
  badgeRing?: readonly [string, string]; // badge-tier ring colors, shown only while a story is active
  showAdd?: boolean;
  addColors?: readonly [string, string]; // gradient for the ＋ button (e.g. the user's badge tier)
  onPressAdd?: () => void;
  style?: StyleProp<ViewStyle>;
};

export default function StoryAvatar({
  userId, avatarUrl, name, size,
  onPressProfile, onBeforeOpenStory, badgeRing,
  showAdd, addColors, onPressAdd, style,
}: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { hasStory, hasUnseen, openStory, ringColors, ringTier } = useStories();
  const story = hasStory(userId);
  const unseen = hasUnseen(userId);
  const wrapRef = useRef<View>(null);

  // A ring shows ONLY while the user has an active story.
  //  • Unseen → the user's badge-tier color (or an explicit `badgeRing` override,
  //    e.g. a styled profile ring), falling back to the default story gradient.
  //  • Seen  → dim to gray. Policy (global): every tier dims once all stories are
  //    watched EXCEPT diamond, whose ring persists in its badge color.
  const GRAY_RING: readonly [string, string] = [colors.textTertiary, colors.textTertiary];
  const badge = badgeRing ?? ringColors(userId);
  const isDiamond = ringTier(userId) === 'diamond';
  const ring: readonly [string, string] | null = !story
    ? null
    : unseen
    ? (badge ?? GRADIENTS.primaryWarm)
    : isDiamond
    ? (badge ?? GRADIENTS.primaryWarm)
    : GRAY_RING;
  const showRing = !!ring;

  const pad = size >= 64 ? 3 : 2;
  const inner = showRing ? size - pad * 2 : size;

  function onPress() {
    if (story && userId) {
      // Measure this circle so the viewer can expand out of it (Instagram-style),
      // then open. Measure first so an overlay closing doesn't shift the rect.
      wrapRef.current?.measureInWindow((x, y, width, height) => {
        onBeforeOpenStory?.();
        openStory(userId, undefined, { x, y, width, height });
      });
    } else {
      onPressProfile?.();
    }
  }
  const tappable = (story && !!userId) || !!onPressProfile;

  const avatarNode = avatarUrl ? (
    <Image
      source={{ uri: avatarUrl }}
      style={[
        { width: inner, height: inner, borderRadius: inner / 2, backgroundColor: colors.surfaceLight },
        story && { borderWidth: 1.5, borderColor: colors.background },
      ]}
      contentFit="cover"
      transition={0}
      cachePolicy="memory-disk"
    />
  ) : (
    <LinearGradient
      colors={GRADIENTS.primary}
      style={[
        { width: inner, height: inner, borderRadius: inner / 2, alignItems: 'center', justifyContent: 'center' },
        story && { borderWidth: 1.5, borderColor: colors.background },
      ]}
    >
      {name === HIDDEN_NAME ? (
        // Masked hidden account — anonymous silhouette, never an initial.
        <Ionicons name="person" size={Math.round(inner * 0.5)} color="#fff" />
      ) : (
        <Text style={{ color: '#fff', fontWeight: '700', fontSize: Math.round(inner * 0.42) }}>
          {name?.charAt(0)?.toUpperCase()}
        </Text>
      )}
    </LinearGradient>
  );

  const content = showRing ? (
    <LinearGradient
      colors={ring!}
      style={[
        { width: size, height: size, borderRadius: size / 2, padding: pad, alignItems: 'center', justifyContent: 'center' },
        // Diamond — the peak status — glows wherever its ring appears.
        isDiamond && badgeGlow('diamond'),
      ]}
    >
      {avatarNode}
    </LinearGradient>
  ) : (
    avatarNode
  );

  return (
    <View ref={wrapRef} style={[{ width: size, height: size }, style]}>
      {tappable ? (
        <TouchableOpacity activeOpacity={0.8} onPress={onPress}>{content}</TouchableOpacity>
      ) : (
        content
      )}
      {showAdd && (
        <TouchableOpacity style={styles.add} onPress={onPressAdd} activeOpacity={0.85} hitSlop={6}>
          <LinearGradient colors={addColors ?? [colors.primary, colors.primary]} style={StyleSheet.absoluteFill} />
          <Ionicons name="add" size={16} color="#fff" />
        </TouchableOpacity>
      )}
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  add: {
    position: 'absolute', bottom: -2, right: -2,
    width: 24, height: 24, borderRadius: 12, overflow: 'hidden',
    borderWidth: 2, borderColor: colors.background,
    alignItems: 'center', justifyContent: 'center',
  },
});
