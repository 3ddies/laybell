import { Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useFollow } from '../contexts/FollowContext';
import { COLORS, RADIUS, SPACING } from '../constants/theme';

// Small orange "Follow" pill shown next to another user's username across the
// feeds. Renders nothing for your own username (or before auth resolves).
export default function FollowButton({ userId, style }: { userId?: string | null; style?: any }) {
  const { currentUserId, following, toggleFollow } = useFollow();

  if (!userId || !currentUserId || userId === currentUserId) return null;

  const isFollowing = following.has(userId);

  return (
    <TouchableOpacity
      style={[styles.btn, isFollowing ? styles.following : styles.follow, style]}
      onPress={() => toggleFollow(userId)}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      activeOpacity={0.8}
    >
      <Text style={[styles.text, isFollowing ? styles.followingText : styles.followText]}>
        {isFollowing ? 'Following' : 'Follow'}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    paddingHorizontal: SPACING.md,
    paddingVertical: 5,
    borderRadius: RADIUS.full,
    borderWidth: 1,
  },
  follow: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  following: { backgroundColor: 'transparent', borderColor: COLORS.border },
  text: { fontSize: 12, fontWeight: '700' },
  followText: { color: '#fff' },
  followingText: { color: COLORS.textSecondary },
});
