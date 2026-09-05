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

const COMMENT_MS = 9000;

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
        toValue: 1, duration: COMMENT_MS, delay, easing: Easing.linear, useNativeDriver: true,
      }),
    );
    loop.start();
    return () => { loop.stop(); t.setValue(0); };
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
          opacity: t.interpolate({ inputRange: [0, 0.12, 0.75, 1], outputRange: [0, 1, 0.95, 0] }),
          transform: [
            { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [0, -travel] }) },
            { translateX: t.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 8, 0] }) },
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
          // Staggered across the loop rather than released together: three
          // bubbles leaving at once reads as a burst, one at a time reads as a
          // room reacting.
          delay={i * (COMMENT_MS / Math.max(1, shown.length))}
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
