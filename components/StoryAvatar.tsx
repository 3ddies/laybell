import { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, Easing, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { GRADIENTS, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { badgeGlow } from '../lib/badges';
import { HIDDEN_NAME } from '../lib/hiddenProfile';
import { useStories } from '../contexts/StoriesContext';
import { useLiveStreamId } from '../lib/liveNow';

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
  /**
   * Gently pulse the circle to nudge the user to post — but ONLY while they have
   * no active story (the pulse stops the moment one goes up). Used on the "Your
   * story" circle in the tray. Native-driven, a soft beat with rests between.
   */
  nudge?: boolean;
  /**
   * Give the ring depth: a soft drop shadow plus a single top-left highlight on
   * the band. Opt-in rather than always-on — it is right for the stories RAIL,
   * where the circles are the content, and wrong for an avatar sitting inline
   * beside a name, where a shadow on 12pt of text-height circle is just noise.
   */
  raised?: boolean;
  style?: StyleProp<ViewStyle>;
};

export default function StoryAvatar({
  userId, avatarUrl, name, size,
  onPressProfile, onBeforeOpenStory, badgeRing,
  showAdd, addColors, onPressAdd, nudge = false, raised = false, style,
}: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { hasStory, hasUnseen, openStory, ringColors, ringTier } = useStories();
  const story = hasStory(userId);
  const unseen = hasUnseen(userId);
  const wrapRef = useRef<View>(null);
  const router = useRouter();
  // LIVE pill: shown while this user is broadcasting (shared 45s poll — see
  // lib/liveNow); tapping it jumps straight into their stream. Hidden on tiny
  // avatars where the pill would be unreadable.
  const liveStreamId = useLiveStreamId(userId);
  const showLive = !!liveStreamId && size >= 32;

  // Story nudge on the "Your story" circle while the user has NO active story: a
  // ~3-second burst of continuous, smooth shrink-and-expand (a few breaths back to
  // back), then a rest before the next burst — so it draws the eye without ever
  // vibrating. Stops the instant a story goes up (`story` flips true) or the circle
  // unmounts. Native-driven; it shares no node, so it drives its own scale freely.
  const nudgeScale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!nudge || story) { nudgeScale.stopAnimation(); nudgeScale.setValue(1); return; }
    const HALF = 500;         // half a breath — 500 out + 500 back = one smooth cycle
    const BURST_CYCLES = 3;   // ~3 seconds of continuous pulsing per burst
    const REST_MS = 2600;     // quiet gap before the next burst triggers
    const breathe = () => Animated.sequence([
      Animated.timing(nudgeScale, { toValue: 1.12, duration: HALF, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(nudgeScale, { toValue: 1, duration: HALF, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]);
    const anim = Animated.loop(Animated.sequence([
      ...Array.from({ length: BURST_CYCLES }, breathe),
      Animated.delay(REST_MS),
    ]));
    const timer = setTimeout(() => anim.start(), 700);
    return () => { clearTimeout(timer); anim.stop(); nudgeScale.setValue(1); };
  }, [nudge, story, nudgeScale]);

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
      colors={GRADIENTS.avatar}
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
        // Lift, when the caller asks for it. Not applied to a Diamond ring,
        // which already carries its own glow — stacking a shadow under that
        // reads as a smudge rather than as depth.
        raised && !isDiamond && styles.lift,
      ]}
    >
      {/* Specular highlight, BEHIND the avatar on purpose: the photo covers the
          middle, so this only ever shows on the ring band itself. Rendered over
          the avatar it would wash out the top of everyone's face.
          A single light source at the top-left, which is the whole trick — one
          consistent highlight is what makes a flat circle read as a bevelled
          one, and two would just look like glare. */}
      {raised && (
        <LinearGradient
          colors={['rgba(255,255,255,0.42)', 'rgba(255,255,255,0.10)', 'transparent']}
          locations={[0, 0.38, 0.72]}
          start={{ x: 0.2, y: 0 }}
          end={{ x: 0.8, y: 1 }}
          style={[StyleSheet.absoluteFill, { borderRadius: size / 2 }]}
          pointerEvents="none"
        />
      )}
      {avatarNode}
    </LinearGradient>
  ) : (
    avatarNode
  );

  return (
    <View ref={wrapRef} style={[{ width: size, height: size }, style]}>
      <Animated.View style={{ width: size, height: size, transform: [{ scale: nudgeScale }] }}>
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
      </Animated.View>
      {showLive && (
        <View style={[styles.liveWrap, { bottom: -Math.max(4, Math.round(size * 0.09)) }]} pointerEvents="box-none">
          <TouchableOpacity
            style={styles.livePill}
            onPress={() => router.push(`/live?streamId=${liveStreamId}`)}
            activeOpacity={0.85}
            hitSlop={6}
          >
            <Text style={[styles.livePillText, { fontSize: Math.max(6.5, Math.min(9, size * 0.17)) }]}>LIVE</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  // Low and soft. A story circle should look like it is resting ON the row, not
  // hovering over it — a bigger offset reads as a sticker peeling off the page.
  lift: {
    shadowColor: '#000',
    shadowOpacity: 0.20,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2.5 },
    elevation: 4,
  },
  add: {
    position: 'absolute', bottom: -2, right: -2,
    width: 24, height: 24, borderRadius: 12, overflow: 'hidden',
    borderWidth: 2, borderColor: colors.background,
    alignItems: 'center', justifyContent: 'center',
  },
  // Bottom-centered LIVE pill (wider slack than the avatar so it can't clip);
  // box-none so the avatar stays tappable around it.
  liveWrap: { position: 'absolute', left: -10, right: -10, alignItems: 'center' },
  livePill: {
    backgroundColor: '#F43F5E', // the app's LIVE red (matches the header disc)
    borderRadius: RADIUS.full,
    paddingHorizontal: 5, paddingVertical: 1.5,
    borderWidth: 1.5, borderColor: colors.background,
  },
  livePillText: { color: '#fff', fontWeight: '800', letterSpacing: 0.4 },
});
