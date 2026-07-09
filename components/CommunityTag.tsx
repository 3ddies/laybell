import { Pressable, Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useRouter } from 'expo-router';

// The community hashtag shown at the end of a post's caption — opens that
// community when tapped. It's a real Pressable (with padding + hit-slop, but NO
// visible background) so the whole tag and a margin around it are easily
// tappable, while still reading like plain inline text. Dim-on-press gives
// instant feedback. Returns null for posts with no community.

// Blueish-purple — readable on dark surfaces and over reel video.
const TINT = '#8B7CF6';

type Props = {
  communityId?: string | null;
  hashtag?: string | null;
  color?: string;
  // Adds a one-space gap on the left — used only for the FIRST tag when a
  // caption precedes it, so the tag reads as separated from the caption text.
  // Omitted (false) when the tag is flush at the start of the text area.
  leading?: boolean;
  style?: StyleProp<ViewStyle>;
};

export default function CommunityTag({ communityId, hashtag, color, leading, style }: Props) {
  const router = useRouter();
  if (!communityId || !hashtag) return null;
  const c = color ?? TINT;
  return (
    <Pressable
      onPress={() => router.push(`/communities/${communityId}`)}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      accessibilityRole="link"
      accessibilityLabel={`#${hashtag}`}
      style={({ pressed }) => [styles.tag, leading && styles.leading, pressed && styles.pressed, style]}
    >
      <Text style={[styles.text, { color: c }]}>#{hashtag}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // No background — invisible hit area. The padding (+ hitSlop) is the target.
  tag: { paddingHorizontal: 2, paddingVertical: 2 },
  // 2px + the tag's own 2px paddingLeft = ~4px, matching the between-tag gap so
  // caption→tag looks like a single space.
  leading: { marginLeft: 2 },
  pressed: { opacity: 0.5 },
  text: { fontSize: 14, fontWeight: '700' },
});
