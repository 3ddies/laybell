import { Text, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFollow } from '../contexts/FollowContext';
import { RADIUS, SPACING, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { selection } from '../lib/haptics';

// Small connection pill shown next to another user's username across the feeds.
// Reflects both follow tiers:
//   • Friends     — mutual follow (outlined + people icon)
//   • Follow back — they follow me, I don't follow them yet (filled, encourages)
//   • Following   — one-directional, I follow them (outlined)
//   • Follow      — no connection (filled)
// Renders nothing for your own username (or before auth resolves).
export default function FollowButton({ userId, style }: { userId?: string | null; style?: any }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { currentUserId, following, followers, toggleFollow } = useFollow();

  if (!userId || !currentUserId || userId === currentUserId) return null;

  const isFollowing = following.has(userId);
  const followsMe = followers.has(userId);
  const isFriend = isFollowing && followsMe;

  const filled = !isFollowing; // Follow / Follow back are the calls-to-action
  const label = isFriend ? t('profile.friends') : isFollowing ? t('profile.followingBtn') : followsMe ? t('profile.followBack') : t('profile.follow');

  return (
    <TouchableOpacity
      style={[styles.btn, filled ? styles.follow : styles.following, style]}
      onPress={() => { selection(); toggleFollow(userId); }}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      activeOpacity={0.8}
    >
      <View style={styles.inner}>
        {isFriend && <Ionicons name="people" size={12} color={colors.textSecondary} />}
        <Text style={[styles.text, filled ? styles.followText : styles.followingText]} numberOfLines={1}>{label}</Text>
      </View>
    </TouchableOpacity>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  btn: {
    paddingHorizontal: SPACING.md,
    paddingVertical: 5,
    borderRadius: RADIUS.full,
    borderWidth: 1,
  },
  inner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  // The call-to-action pill is INVERTED rather than orange (owner, 2026-08-10):
  // near-white on the dark themes, which is what was asked for, and it stops the
  // feed competing with itself — orange is also the brand's own accent, so a row
  // of orange Follow pills pulled the eye away from the posts.
  //
  // Written as text/background rather than a literal '#fff' so it stays legible
  // on the LIGHT theme, where a white pill on the off-white paper background
  // (#F2F1ED) would all but disappear. There it flips to near-black — same
  // inverted look, same contrast, no invisible button.
  follow: { backgroundColor: colors.text, borderColor: colors.text },
  following: { backgroundColor: 'transparent', borderColor: colors.border },
  text: { fontSize: 12, fontWeight: '700' },
  followText: { color: colors.background },
  followingText: { color: colors.textSecondary },
});
