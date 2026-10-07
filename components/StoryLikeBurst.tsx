import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated, Easing, Pressable } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../constants/theme';
import type { StoryLiker } from '../lib/stories';

// The "like" red, matched to the heart used everywhere else (theme.like / #F43F5E).
const HEART = '#F43F5E';
// Gold for the pinned-comment pin.
const GOLD = '#FFC53D';
// Where a liker's pic pauses to "speak" (well above the heart stream) and where it exits.
const HOLD_Y = -148;
const EXIT_Y = -176;
// Avatar base = the BIG, frozen-comment size; a plain drift-by scales it down small.
const AVATAR = 52;
const FLOAT_SCALE = 0.56; // ~29px when merely drifting past (no comment)
const RISE_MS = 640;      // pic rises into the hold
const FADE_MS = 460;      // pic fades out after the hold
const DRIFT_MS = 2100;    // a plain (comment-less) drift-by's whole life
// Each comment's on-screen hold. Default/target is MAX (1.5s); when more comments
// need to fit in the story's run it compresses toward the MIN (1.2s) floor. Below
// 1.2s it would read as glitchy, so it stops there and any extras just don't show
// (per owner spec: fit as many at 1.5s, else 1.2s, no faster).
const MIN_HOLD = 1200;
const MAX_HOLD = 1500;

// One heart that drifts up and fades, forever, offset by `delay` so a set of them
// reads as a continuous rise. Native-driven, cheap enough to loop while a story plays.
function FloatingHeart({ delay, startX, drift, size, duration }: {
  delay: number; startX: number; drift: number; size: number; duration: number;
}) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.delay(delay),
      Animated.timing(v, { toValue: 1, duration, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [v, delay, duration]);
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute', left: startX, bottom: 0,
        shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 3, shadowOffset: { width: 0, height: 1 },
        opacity: v.interpolate({ inputRange: [0, 0.12, 0.7, 1], outputRange: [0, 0.95, 0.78, 0] }),
        transform: [
          { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -64] }) },
          { translateX: v.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, drift, 0] }) },
          { scale: v.interpolate({ inputRange: [0, 0.25, 1], outputRange: [0.4, 1.12, 0.72] }) },
        ],
      }}
    >
      <Ionicons name="heart" size={size} color={HEART} />
    </Animated.View>
  );
}

// A liker's profile pic rising "in the mix". If they left a comment it FREEZES above
// the hearts — grown BIG, @username under it, a white speech bubble over it, and
// TAPPABLE (opens their profile) — for a story-length-scaled hold, then fades;
// otherwise it just drifts up small and fades. Then it cycles to the next liker.
//
// Driven by ONE linear 0→1 value per item (the "hold" is a plateau in the
// interpolations), so `paused` can freeze it mid-flight and resume it exactly — a
// tap-and-hold on the story holds the comment on screen instead of cycling past it.
function AvatarFloat({ likers, paused, commentHoldMs, onOpenProfile }: {
  likers: StoryLiker[]; paused: boolean; commentHoldMs: number; onOpenProfile?: (id: string) => void;
}) {
  const [cycle, setCycle] = useState(0);        // advances once per item shown
  const v = useRef(new Animated.Value(0)).current;
  const posRef = useRef(0);                      // frozen 0..1 progress, for resume
  const keyRef = useRef('');                     // which cycle the value is currently on

  // Each liker is shown EXACTLY ONCE this watch (RPC order: pinned → commented →
  // newest): a commented one freezes with its bubble, a plain like drifts its pic up
  // once. After everyone's had their turn the floater STOPS — no pic ever repeats —
  // and just the hearts keep going.
  const liker = cycle < likers.length ? likers[cycle] : null;
  const comment = liker?.comment?.trim() || null;
  const hasComment = !!comment;
  const hold = hasComment ? commentHoldMs : 0;
  const total = hasComment ? (RISE_MS + hold + FADE_MS) : DRIFT_MS;
  const a = hasComment ? RISE_MS / total : 0;          // reaches the hold
  const b = hasComment ? (RISE_MS + hold) / total : 0; // leaves the hold

  useEffect(() => {
    if (!liker) return;
    const key = String(cycle);
    if (keyRef.current !== key) { keyRef.current = key; posRef.current = 0; v.setValue(0); } // new item → from the start
    if (paused) {
      v.stopAnimation((val) => { if (typeof val === 'number') posRef.current = val; });       // freeze in place
      return;
    }
    let alive = true;
    const anim = Animated.timing(v, {
      toValue: 1,
      duration: Math.max(16, total * (1 - posRef.current)), // resume the remainder
      easing: Easing.linear,
      useNativeDriver: true,
    });
    anim.start(({ finished }) => { if (finished && alive) setCycle((c) => c + 1); });
    return () => { alive = false; anim.stop(); };
  }, [cycle, paused, total, likers.length, v]);

  if (!liker) return null;

  const translateY = hasComment
    ? v.interpolate({ inputRange: [0, a, b, 1], outputRange: [0, HOLD_Y, HOLD_Y, EXIT_Y], extrapolate: 'clamp' })
    : v.interpolate({ inputRange: [0, 1], outputRange: [0, EXIT_Y], extrapolate: 'clamp' });
  const picOpacity = hasComment
    ? v.interpolate({ inputRange: [0, a * 0.5, b, 1], outputRange: [0, 1, 1, 0], extrapolate: 'clamp' })
    : v.interpolate({ inputRange: [0, 0.18, 0.8, 1], outputRange: [0, 1, 0.9, 0], extrapolate: 'clamp' });
  const scale = hasComment
    ? v.interpolate({ inputRange: [0, a * 0.7, a, b, 1], outputRange: [0.4, 1.08, 1, 1, 0.92], extrapolate: 'clamp' })
    : v.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0.34, FLOAT_SCALE, 0.48], extrapolate: 'clamp' });
  const bEnd = Math.min(0.999, b + (1 - b) * 0.3);
  const bubbleOpacity = hasComment
    ? v.interpolate({ inputRange: [a * 0.85, a, b, bEnd], outputRange: [0, 1, 1, 0], extrapolate: 'clamp' })
    : undefined;
  const bubbleScale = hasComment
    ? v.interpolate({ inputRange: [a * 0.85, a, 1], outputRange: [0.5, 1, 1.06], extrapolate: 'clamp' })
    : undefined;

  const avatarInner = liker.avatar
    ? <ExpoImage source={{ uri: liker.avatar }} style={styles.avatarImg} contentFit="cover" cachePolicy="memory-disk" transition={120} />
    : <Ionicons name="person" size={Math.round(AVATAR * 0.5)} color="#fff" />;
  // Only the frozen, named pic is tappable — big, still, a real target; the fast
  // drift-bys stay non-interactive. box-none lets the pic's Pressable get the touch
  // while empty area falls through to the story's tap-to-advance beneath.
  const clickable = hasComment && !!liker.id && !!onOpenProfile;
  return (
    <Animated.View
      pointerEvents={clickable ? 'box-none' : 'none'}
      style={[styles.floater, { opacity: picOpacity, transform: [{ translateY }, { scale }] }]}
    >
      {hasComment && (
        <Animated.View style={[styles.bubbleWrap, { opacity: bubbleOpacity, transform: [{ scale: bubbleScale as any }] }]}>
          <View style={[styles.bubble, liker.pinned && styles.bubblePinned]}>
            <Text style={styles.bubbleText} numberOfLines={3}>{comment}</Text>
            {liker.pinned && (
              <View style={styles.pinBadge}>
                <Ionicons name="pin" size={12} color="#5A3E00" />
              </View>
            )}
          </View>
          <View style={styles.bubbleTail} />
        </Animated.View>
      )}
      {clickable ? (
        <Pressable style={styles.avatar} onPress={() => onOpenProfile!(liker.id!)} hitSlop={10} accessibilityRole="button">
          {avatarInner}
        </Pressable>
      ) : (
        <View style={styles.avatar}>{avatarInner}</View>
      )}
      {hasComment && !!liker.username && (
        <Animated.Text style={[styles.username, { opacity: bubbleOpacity }]} numberOfLines={1}>
          @{liker.username}
        </Animated.Text>
      )}
    </Animated.View>
  );
}

/**
 * The fun "this story is liked" effect, shown to EVERY viewer of a liked story: red
 * hearts drift up — more/faster/bigger as the like `count` climbs — with likers'
 * profile pics flashing by in the mix. A liker who left a comment FREEZES big with
 * their @username + a white speech bubble (and is tappable → their profile); others
 * drift by small. `paused` freezes the frozen-pic timeline (tap-and-hold the story
 * holds the comment); `storyDurationMs` paces the comments so each gets a fair slice
 * of the time the story is on screen. Rendered only when count > 0.
 */
export default function StoryLikeBurst({ count, likers = [], paused = false, storyDurationMs = 10000, onOpenProfile }: {
  count: number; likers?: StoryLiker[]; paused?: boolean; storyDurationMs?: number; onOpenProfile?: (id: string) => void;
}) {
  // Ramp the hearts with the like count: 0 at a single like → full by ~15 likes.
  const intensity = Math.min(1, Math.max(0, (count - 1) / 14));
  const numHearts = Math.max(5, Math.min(14, Math.round(4 + count * 0.8)));
  const cycle = Math.max(1500, 2300 - count * 60); // more likes → faster stream
  const hearts = Array.from({ length: numHearts }, (_, i) => ({
    delay: Math.round((i / numHearts) * cycle),
    startX: 4 + ((i * 9) % 30),
    drift: (i % 2 ? 1 : -1) * (4 + (i % 3) * 2),
    size: 17 + (i % 3) * 2 + Math.round(intensity * 4),
    duration: cycle + (i % 3) * 140,
  }));

  // Fair screen time per comment: 1.5s target, compressing toward a 1.2s floor so as
  // many as possible fit the story's run; `- overhead` reserves each comment's
  // rise+fade. Comment-less drift-bys are unaffected.
  const numCommented = likers.reduce((n, l) => n + (l.comment?.trim() ? 1 : 0), 0);
  const commentHoldMs = Math.max(MIN_HOLD, Math.min(MAX_HOLD,
    Math.round(storyDurationMs / Math.max(1, numCommented)) - (RISE_MS + FADE_MS)));

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      {hearts.map((h, i) => <FloatingHeart key={`${numHearts}:${i}`} {...h} />)}
      {likers.length > 0 && (
        <AvatarFloat likers={likers} paused={paused} commentHoldMs={commentHoldMs} onOpenProfile={onOpenProfile} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // A corner column the hearts rise through (right-anchored by the caller).
  wrap: { width: 60, height: 84, alignItems: 'flex-end', justifyContent: 'flex-end' },
  // Avatar-sized box so the scale transform anchors on the pic; bubble + username
  // are absolute children that overflow it (up and down).
  floater: { position: 'absolute', right: 0, bottom: 0, width: AVATAR, height: AVATAR },
  avatar: {
    width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2,
    overflow: 'hidden', backgroundColor: COLORS.avatarBg,
    borderWidth: 2.5, borderColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 5, shadowOffset: { width: 0, height: 2 },
  },
  avatarImg: { width: '100%', height: '100%' },
  // @username under the pic, centred on it (the ±40 insets make a symmetric box).
  username: {
    position: 'absolute', top: AVATAR + 4, left: -40, right: -40,
    textAlign: 'center', color: '#fff', fontSize: 12.5, fontWeight: '800', letterSpacing: -0.2,
    textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 4, textShadowOffset: { width: 0, height: 1 },
  },
  // White, rounded, "fun" speech bubble with black words. EXPLICIT width (it lives in
  // the small avatar box, so an auto width would clamp the text to ~52px and wrap it
  // one letter per line); a fixed-width wrapper + flex-end lets it size to content.
  bubbleWrap: { position: 'absolute', bottom: AVATAR + 12, right: -6, width: 230, alignItems: 'flex-end' },
  bubble: {
    backgroundColor: '#fff', borderRadius: 20,
    paddingHorizontal: 14, paddingVertical: 9,
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
  },
  bubblePinned: { borderWidth: 2, borderColor: GOLD },
  bubbleText: { color: '#141416', fontSize: 14.5, fontWeight: '700', lineHeight: 19 },
  bubbleTail: {
    position: 'absolute', bottom: -6, right: 22,
    width: 0, height: 0,
    borderLeftWidth: 7, borderRightWidth: 7, borderTopWidth: 9,
    borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: '#fff',
  },
  // The pinned comment gets a gold ring + a gold pin disc at its top-right corner.
  pinBadge: {
    position: 'absolute', top: -9, right: -9,
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: GOLD, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: '#fff',
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 3, shadowOffset: { width: 0, height: 1 },
  },
});
