import { Text, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFollow } from '../contexts/FollowContext';
import { COLORS, RADIUS, SPACING } from '../constants/theme';

// Small connection pill shown next to another user's username across the feeds.
// Reflects both follow tiers:
//   • Friends     — mutual follow (outlined + people icon)
//   • Follow back — they follow me, I don't follow them yet (filled, encourages)
//   • Following   — one-directional, I follow them (outlined)
//   • Follow      — no connection (filled)
// Renders nothing for your own username (or before auth resolves).
export default function FollowButton({ userId, style }: { userId?: string | null; style?: any }) {
  const { currentUserId, following, followers, toggleFollow } = useFollow();

  if (!userId || !currentUserId || userId === currentUserId) return null;

  const isFollowing = following.has(userId);
  const followsMe = followers.has(userId);
  const isFriend = isFollowing && followsMe;

  const filled = !isFollowing; // Follow / Follow back are the calls-to-action
  const label = isFriend ? 'Friends' : isFollowing ? 'Following' : followsMe ? 'Follow back' : 'Follow';

  return (
    <TouchableOpacity
      style={[styles.btn, filled ? styles.follow : styles.following, style]}
      onPress={() => toggleFollow(userId)}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      activeOpacity={0.8}
    >
      <View style={styles.inner}>
        {isFriend && <Ionicons name="people" size={12} color={COLORS.textSecondary} />}
        <Text style={[styles.text, filled ? styles.followText : styles.followingText]} numberOfLines={1}>{label}</Text>
      </View>
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
  inner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  follow: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  following: { backgroundColor: 'transparent', borderColor: COLORS.border },
  text: { fontSize: 12, fontWeight: '700' },
  followText: { color: '#fff' },
  followingText: { color: COLORS.textSecondary },
});
