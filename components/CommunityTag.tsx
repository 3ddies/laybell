import { Pressable, Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../contexts/ThemeContext';

// The community hashtag shown at the end of a post's caption — opens that
// community when tapped. It's a real Pressable (with padding + hit-slop, but NO
// visible background) so the whole tag and a margin around it are easily
// tappable, while still reading like plain inline text. Dim-on-press gives
// instant feedback. Returns null for posts with no community.

/**
 * The blueish-purple for a tag sitting on MEDIA rather than on a themed
 * surface — a reel caption over video, where the ground is dark whatever theme
 * the phone is in. Exported so the reel can ask for it by name instead of
 * happening to inherit it.
 *
 * On themed surfaces the tag uses colors.communityTint, which is this same
 * violet in dark and a deeper one in light: #8B7CF6 measures 2.94:1 on the light
 * background, under even the large-text bar, so it read as decoration rather
 * than as a link there.
 */
export const COMMUNITY_TINT_ON_MEDIA = '#8B7CF6';

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
  const { colors } = useTheme();
  if (!communityId || !hashtag) return null;
  const c = color ?? colors.communityTint;
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
