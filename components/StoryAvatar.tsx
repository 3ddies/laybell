import { useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, GRADIENTS } from '../constants/theme';
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
  onPressAdd?: () => void;
  style?: StyleProp<ViewStyle>;
};

export default function StoryAvatar({
  userId, avatarUrl, name, size,
  onPressProfile, onBeforeOpenStory, badgeRing,
  showAdd, onPressAdd, style,
}: Props) {
  const { hasStory, hasUnseen, openStory, ringColors } = useStories();
  const story = hasStory(userId);
  const unseen = hasUnseen(userId);
  const wrapRef = useRef<View>(null);

  // A ring shows ONLY while the user has an active story. Its color is the user's
  // badge tier — resolved globally from the context so the badge ring shows on any
  // avatar app-wide — or an explicit `badgeRing` override (e.g. a styled profile
  // ring). With no badge it falls back to the story gradient (unseen) / gray (seen).
  // No story → no ring.
  const badge = badgeRing ?? ringColors(userId);
  const ring: readonly [string, string] | null = story
    ? (badge ?? (unseen ? GRADIENTS.primaryWarm : [COLORS.textTertiary, COLORS.textTertiary]))
    : null;
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
        { width: inner, height: inner, borderRadius: inner / 2, backgroundColor: COLORS.surfaceLight },
        story && { borderWidth: 1.5, borderColor: COLORS.background },
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
        story && { borderWidth: 1.5, borderColor: COLORS.background },
      ]}
    >
      <Text style={{ color: '#fff', fontWeight: '700', fontSize: Math.round(inner * 0.42) }}>
        {name?.charAt(0)?.toUpperCase()}
      </Text>
    </LinearGradient>
  );

  const content = showRing ? (
    <LinearGradient
      colors={ring!}
      style={{ width: size, height: size, borderRadius: size / 2, padding: pad, alignItems: 'center', justifyContent: 'center' }}
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
          <Ionicons name="add" size={15} color="#fff" />
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  add: {
    position: 'absolute', bottom: -2, right: -2,
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: COLORS.primary,
    borderWidth: 2, borderColor: COLORS.background,
    alignItems: 'center', justifyContent: 'center',
  },
});
