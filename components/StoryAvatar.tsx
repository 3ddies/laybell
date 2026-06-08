import { useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, GRADIENTS } from '../constants/theme';
import { useStories } from '../contexts/StoriesContext';

// Drop-in avatar that shows a story ring (gradient = unseen, gray = seen) and
// opens the story viewer on tap when `userId` has an active story; otherwise it
// falls back to `onPressProfile`. `size` is the OUTER footprint, so it occupies
// the same space as the avatar it replaces (the image shrinks slightly to fit a
// ring, like Instagram). Pass `ringColorsWhenNoStory` to keep an existing ring
// (e.g. a badge-tier ring) when there's no story.

type Props = {
  userId?: string | null;
  avatarUrl?: string | null;
  name?: string | null;
  size: number;
  onPressProfile?: () => void;
  onBeforeOpenStory?: () => void; // e.g. close an overlay before pushing the viewer
  ringColorsWhenNoStory?: readonly [string, string];
  showAdd?: boolean;
  onPressAdd?: () => void;
  style?: StyleProp<ViewStyle>;
};

export default function StoryAvatar({
  userId, avatarUrl, name, size,
  onPressProfile, onBeforeOpenStory, ringColorsWhenNoStory,
  showAdd, onPressAdd, style,
}: Props) {
  const { hasStory, hasUnseen, openStory } = useStories();
  const story = hasStory(userId);
  const unseen = hasUnseen(userId);
  const wrapRef = useRef<View>(null);

  const ringColors: readonly [string, string] | null = story
    ? (unseen ? GRADIENTS.primaryWarm : [COLORS.textTertiary, COLORS.textTertiary])
    : (ringColorsWhenNoStory ?? null);
  const showRing = !!ringColors;

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
      colors={ringColors!}
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
