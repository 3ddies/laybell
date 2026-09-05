import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Animated, Easing, AccessibilityInfo,
  type StyleProp, type ViewStyle,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useThemedStyles } from '../contexts/ThemeContext';
import { fetchTopComments, type TopComment } from '../lib/topComments';

// A post's best comments drifting up over its artwork — avatar, name, and either
// the words or the gif they sent.
//
// Shared by the feed's square song card and the immersive player, because they
// are the same effect on the same data and a second copy would drift. Both are
// full-bleed artwork with room above the controls; the layer is positioned by
// the caller since only the caller knows where its own controls sit.
//
// Decorative throughout. The fetch returns [] on any failure and this renders
// nothing, so it can never be the reason a card or a player fails to draw.

// A given comment appears at most ONCE per this window.
//
// On a track with two or three comments a short loop just replays the same
// faces over and over, which stops reading as a room reacting and starts
// reading as a slideshow. Thirty seconds is long enough that a repeat feels
// like the track coming back around rather than a stutter.
const COMMENT_CYCLE_MS = 30_000;
// How long one bubble is actually on screen. The rest of the cycle is the gap —
// the same shape the player's floating notes use.
const COMMENT_LIFE_MS = 9_000;
// The visible fraction of the driver. Every interpolation below is expressed
// against this so the bubble finishes its rise at the exact instant it becomes
// invisible: nothing moves while it cannot be seen, and the reset back to the
// bottom is never witnessed.
const LIFE = COMMENT_LIFE_MS / COMMENT_CYCLE_MS;

/**
 * One comment rising.
 *
 * A single native 0→1 driver with position and opacity interpolated off it, so
 * three bubbles cost three animations rather than twelve, and none of them can
 * fall out of step with the others.
 */
function FloatingComment({ comment, delay, travel, still }: {
  comment: TopComment; delay: number; travel: number; still: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const t = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (still) return;
    const loop = Animated.loop(
      Animated.timing(t, {
        toValue: 1, duration: COMMENT_CYCLE_MS, easing: Easing.linear, useNativeDriver: true,
      }),
    );
    // Staggered by a TIMER, not an Animated.delay inside the loop. A delay inside
    // repeats every cycle, so each bubble's true period becomes cycle+delay and
    // the three of them drift apart from each other over a few minutes. This
    // offsets each one once and then they all run on the same fixed period.
    // (The player's floating notes learned this first — see ImmersivePlayer.)
    const kick = setTimeout(() => loop.start(), delay);
    return () => { clearTimeout(kick); loop.stop(); t.setValue(0); };
  }, [delay, t, still, comment.id]);

  const body = (
    <>
      {comment.avatarUrl ? (
        <ExpoImage source={{ uri: comment.avatarUrl }} style={styles.avatar} contentFit="cover" cachePolicy="memory-disk" />
      ) : (
        <LinearGradient colors={GRADIENTS.avatar} style={styles.avatar} />
      )}
      <View style={styles.text}>
        <Text style={styles.name} numberOfLines={1}>{comment.name}</Text>
        {comment.gifUrl ? (
          // The real gif, playing. Seeing what somebody actually sent is the
          // whole charm — a "[GIF]" label states the fact and loses the joke.
          <View style={styles.mediaRow}>
            <ExpoImage source={{ uri: comment.gifUrl }} style={styles.gif} contentFit="cover" cachePolicy="memory-disk" />
            {!!comment.text && <Text style={styles.bodyText} numberOfLines={1}>{comment.text}</Text>}
          </View>
        ) : comment.isImage && !comment.text ? (
          // An uploaded photo is somebody's own picture rather than a shared
          // joke, so it is marked, not shown. A decorative overlay is a poor
          // place to reveal a person's photo unasked.
          <View style={styles.mediaRow}>
            <Ionicons name="image-outline" size={13} color="rgba(255,255,255,0.85)" />
            <Text style={styles.bodyText} numberOfLines={1}>{'•'}</Text>
          </View>
        ) : (
          <Text style={styles.bodyText} numberOfLines={1}>{comment.text}</Text>
        )}
      </View>
    </>
  );

  // Reduced motion: the same bubble, parked. The comment is information, not
  // just decoration, so it is kept — it simply stops moving.
  if (still) return <View style={[styles.bubble, styles.bubbleStill]}>{body}</View>;

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.bubble,
        {
          // Every stop is a fraction of LIFE, so the bubble is fully gone by the
          // time the rise ends and stays gone for the remaining ~70% of the
          // cycle — that silence is the point of the 30s window.
          opacity: t.interpolate({
            inputRange: [0, LIFE * 0.12, LIFE * 0.75, LIFE, 1],
            outputRange: [0, 1, 0.95, 0, 0],
          }),
          transform: [
            // Holds at the top of its rise once invisible, rather than creeping
            // on for another twenty seconds.
            { translateY: t.interpolate({ inputRange: [0, LIFE, 1], outputRange: [0, -travel, -travel] }) },
            { translateX: t.interpolate({ inputRange: [0, LIFE * 0.5, LIFE, 1], outputRange: [0, 8, 0, 0] }) },
          ],
        },
      ]}
    >
      {body}
    </Animated.View>
  );
}

export default function FloatingComments({
  postId, max = 3, travel = 132, style,
}: {
  /** The post whose comments to float. Track.id IS the post id (see toTrack). */
  postId: string | null | undefined;
  max?: number;
  /** How far a bubble rises before fading out. */
  travel?: number;
  /** Where the band sits — only the caller knows where its own controls are. */
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useThemedStyles(makeStyles);
  const [comments, setComments] = useState<TopComment[]>([]);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let alive = true;
    setComments([]);
    if (!postId) return;
    fetchTopComments(postId, max).then((rows) => { if (alive) setComments(rows); }).catch(() => {});
    return () => { alive = false; };
  }, [postId, max]);

  // Honour the OS setting rather than animating regardless. Motion that drifts
  // across artwork is exactly what this setting exists to stop.
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => { if (alive) setReduceMotion(on); })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (on) => setReduceMotion(!!on));
    return () => { alive = false; sub?.remove?.(); };
  }, []);

  if (comments.length === 0) return null;

  // Parked, only the top comment is shown — a stack of three motionless bubbles
  // is clutter where a sequence of one was a rhythm.
  const shown = reduceMotion ? comments.slice(0, 1) : comments;

  return (
    <View style={[styles.layer, style]} pointerEvents="none">
      {shown.map((c, i) => (
        <FloatingComment
          key={`${postId}-${c.id}`}
          comment={c}
          // Spread evenly across the WINDOW, not across one bubble's life: with
          // three comments that is one arriving every ten seconds, each returning
          // only after the full thirty. Three released together would read as a
          // burst; this reads as a room reacting.
          delay={i * (COMMENT_CYCLE_MS / Math.max(1, shown.length))}
          travel={travel}
          still={reduceMotion}
        />
      ))}
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  layer: { position: 'absolute', justifyContent: 'flex-end' },
  bubble: {
    position: 'absolute', bottom: 0, left: 0,
    flexDirection: 'row', alignItems: 'center', gap: 7,
    maxWidth: '82%',
    backgroundColor: 'rgba(0,0,0,0.42)',
    borderRadius: RADIUS.full,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)',
    paddingLeft: 4, paddingRight: 11, paddingVertical: 4,
  },
  bubbleStill: { opacity: 0.95 },
  avatar: { width: 24, height: 24, borderRadius: 12 },
  text: { flexShrink: 1, minWidth: 0 },
  name: { color: 'rgba(255,255,255,0.72)', fontSize: 10.5, fontWeight: '700' },
  bodyText: { color: '#fff', fontSize: 12.5, fontWeight: '600', flexShrink: 1 },
  mediaRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  gif: { width: 34, height: 22, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.12)' },
});
