import { Text, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
// The app's one celebratory gradient — shared, not copied, so the Listen pill,
// the sign-in buttons and this stay identical.
import { LISTEN_FILL } from './ListenButton';
import { useFollow } from '../contexts/FollowContext';
import { RADIUS, SPACING, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { selection } from '../lib/haptics';

// Small connection pill shown next to another user's username across the feeds.
//
// FOUR STATES, FOUR LOOKS (owner asked for them to stop sharing skins, 2026-08-10).
// The ranking is by how much the button still wants a tap:
//
//   • Follow      — a stranger. The loudest thing: a white pill with a soft
//                   top-down sheen and a lift shadow, so it reads as a physical
//                   key rather than a flat rectangle. Most common state, so it
//                   sets the feed's rhythm.
//   • Follow back — they already followed YOU. Rarer, warmer, and the highest-
//                   intent tap in the app, so it gets the app's one celebratory
//                   gradient — the same gold-to-orange the Listen pill and the
//                   sign-in buttons wear. Warmth returns here deliberately: it
//                   appears occasionally, as a little "they like you" moment,
//                   not as the wall of orange that made every Follow shout.
//   • Following   — already connected, one way. Quiet outline; nothing to do.
//   • Friends     — mutual. Same quiet weight as Following (there is no action
//                   left) but marked as its own thing with the people icon and a
//                   faintly brand-tinted edge.
//
// The white of Follow is written from the palette, not hardcoded: on the LIGHT
// theme a white pill on off-white paper (#F2F1ED) would vanish, so it inverts to
// near-black there — same idea, same contrast, still legible.
// NOTE FOR CALLERS: `style` lands on the SHELL, which owns only the shape and
// the shadow — the padding lives on an inner fill so the gradient reaches the
// rounded edge with no seam. So pass LAYOUT only (margin, alignSelf, minWidth,
// which the fill stretches to). Passing padding here pads around the pill
// rather than inside it, and passing alignSelf:'stretch' turns it into a slab.
// Both of those shipped as bugs once; that is why this comment exists.
export default function FollowButton({ userId, style }: { userId?: string | null; style?: any }) {
  const { colors, mode } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { currentUserId, following, followers, toggleFollow } = useFollow();

  if (!userId || !currentUserId || userId === currentUserId) return null;

  const isFollowing = following.has(userId);
  const followsMe = followers.has(userId);
  const isFriend = isFollowing && followsMe;
  const isFollowBack = !isFollowing && followsMe;
  const isFollow = !isFollowing && !followsMe;

  const label = isFriend ? t('profile.friends')
    : isFollowing ? t('profile.followingBtn')
    : followsMe ? t('profile.followBack')
    : t('profile.follow');

  // Two stops, close together: enough to catch the light like a real surface,
  // not so much that it reads as a grey button. On light the pair inverts.
  const solidStops: readonly [string, string] = mode === 'light'
    ? ['#2E2E36', '#16161A']
    : ['#FFFFFF', '#E3E3E9'];

  const inner = (
    <View style={styles.inner}>
      {isFriend && <Ionicons name="people" size={12} color={colors.primary} />}
      <Text
        style={[
          styles.text,
          isFollow ? styles.followText : isFollowBack ? styles.followBackText
            : isFriend ? styles.friendsText : styles.followingText,
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );

  // The two filled states carry a gradient, so they wrap their content; the two
  // connected states are plain bordered views.
  if (isFollow || isFollowBack) {
    return (
      <TouchableOpacity
        style={[styles.shell, isFollow ? styles.followLift : styles.followBackLift, style]}
        onPress={() => { selection(); toggleFollow(userId); }}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        {/* Follow back wears the LISTEN-MODE fill (owner, 2026-08-28) rather than
            GRADIENTS.primary. Two reasons it is the better pill: it is gold-led
            instead of red-led, so it reads as an invitation rather than a
            warning, and it now matches the Listen pill and the sign-in buttons —
            the app has ONE celebratory gradient instead of two similar oranges
            nobody could tell apart.
            The angle goes diagonal with it, matching those; the solid Follow
            state keeps its vertical fall, which is what makes a plain pill look
            lit rather than tinted. */}
        <LinearGradient
          colors={(isFollow ? solidStops : LISTEN_FILL) as any}
          start={{ x: 0, y: 0 }}
          end={isFollow ? { x: 0, y: 1 } : { x: 1, y: 1 }}
          style={styles.fill}
        >
          {inner}
        </LinearGradient>
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity
      style={[styles.shell, styles.outlined, isFriend ? styles.friends : styles.following, style]}
      onPress={() => { selection(); toggleFollow(userId); }}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {inner}
    </TouchableOpacity>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  // The shell owns the shape + shadow; the gradient inside owns the padding, so
  // the fill reaches the rounded edge with no seam.
  shell: { borderRadius: RADIUS.full, overflow: 'hidden' },
  fill: { paddingHorizontal: SPACING.md, paddingVertical: 5.5 },
  outlined: {
    paddingHorizontal: SPACING.md,
    paddingVertical: 5,
    borderWidth: 1,
    backgroundColor: 'transparent',
  },
  inner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },

  // Lift: a tight, low-opacity shadow. A white pill sitting flat on near-black
  // looks pasted on; a small drop separates it from the post behind it.
  // overflow:'hidden' on the shell would clip a shadow on Android, so elevation
  // stays modest and iOS carries the real depth.
  followLift: {
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35, shadowRadius: 5, elevation: 3,
  },
  // The brand pill glows in its own colour instead of black — warmth, not depth.
  followBackLift: {
    shadowColor: colors.primary, shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.45, shadowRadius: 6, elevation: 3,
  },

  following: { borderColor: colors.border },
  // Mutual: the edge picks up a trace of brand so it is not just "Following
  // with an icon" at a glance.
  friends: { borderColor: colors.primary + '55' },

  // Slight negative tracking: at 12px, tight caps read as a deliberate label
  // rather than shrunken body text.
  text: { fontSize: 12, fontWeight: '800', letterSpacing: -0.1 },
  followText: { color: colors.background },
  followBackText: { color: '#fff' },
  followingText: { color: colors.textSecondary, fontWeight: '700' },
  friendsText: { color: colors.textSecondary, fontWeight: '700' },
});
