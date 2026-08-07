import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from 'react-native';

// The floating bubbles from the Settings Premium card, extracted so the
// Premium+ paywall card can carry the same signature. Lives at module scope
// per the house rule (components defined inside a render body get remounted
// every render). Pure native-driver loops — nothing touches the JS thread
// after start — and Reduce Motion renders the same field as static bubbles
// instead of animating it, matching how the bell handles that setting.
//
// The field was tuned on the 108px settings card (see that file's history for
// the readability math: a 0.40 peak over a 0.20 fill is ~0.08 effective white,
// which a bold label sits on comfortably). The paywall hero is taller, so the
// bubbles surface across its lower two-thirds — right where a rise should
// start.
const BUBBLES = [
  { left: '26%', size: 14, peak: 0.38, drift: 40, sway: 6, startY: 70, dur: 8400, delay: 1800 },
  { left: '38%', size: 19, peak: 0.32, drift: 46, sway: -7, startY: 76, dur: 10200, delay: 0 },
  { left: '48%', size: 11, peak: 0.30, drift: 34, sway: 6, startY: 60, dur: 8800, delay: 6200 },
  { left: '55%', size: 13, peak: 0.34, drift: 34, sway: 5, startY: 56, dur: 7600, delay: 3400 },
  { left: '68%', size: 17, peak: 0.40, drift: 44, sway: -8, startY: 74, dur: 9200, delay: 5000 },
  { left: '80%', size: 12, peak: 0.48, drift: 38, sway: 6, startY: 66, dur: 8000, delay: 4200 },
  { left: '85%', size: 23, peak: 0.72, drift: 48, sway: 7, startY: 72, dur: 9800, delay: 900 },
  { left: '93%', size: 13, peak: 0.62, drift: 36, sway: -5, startY: 54, dur: 7400, delay: 2600 },
] as const;

export default function PremiumBubbles() {
  const [reduceMotion, setReduceMotion] = useState(false);
  const anims = useRef(BUBBLES.map(() => new Animated.Value(0))).current;

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => { if (alive) setReduceMotion(on); })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { alive = false; sub?.remove?.(); };
  }, []);

  useEffect(() => {
    if (reduceMotion) return;
    const loops = anims.map((v, i) => {
      const b = BUBBLES[i];
      v.setValue(0);
      // The delay sits INSIDE the loop, so each bubble also rests between
      // cycles — they surface at varied moments instead of streaming.
      const loop = Animated.loop(Animated.sequence([
        Animated.delay(b.delay),
        Animated.timing(v, { toValue: 1, duration: b.dur, easing: Easing.linear, useNativeDriver: true }),
      ]));
      loop.start();
      return loop;
    });
    return () => loops.forEach((l) => l.stop());
  }, [reduceMotion, anims]);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {BUBBLES.map((b, i) => reduceMotion ? (
        <View
          key={i}
          style={[styles.bubble, {
            left: b.left, top: b.startY - b.drift / 2,
            width: b.size, height: b.size, borderRadius: b.size / 2,
            opacity: b.peak * 0.5,
          }]}
        />
      ) : (
        <Animated.View
          key={i}
          style={[styles.bubble, {
            left: b.left, top: b.startY,
            width: b.size, height: b.size, borderRadius: b.size / 2,
            opacity: anims[i].interpolate({
              inputRange: [0, 0.18, 0.8, 1],
              outputRange: [0, b.peak, b.peak * 0.8, 0],
            }),
            transform: [
              { translateY: anims[i].interpolate({ inputRange: [0, 1], outputRange: [0, -b.drift] }) },
              // A soft S-path: out, back through centre, opposite, home — what
              // makes it read as floating rather than launched.
              {
                translateX: anims[i].interpolate({
                  inputRange: [0, 0.25, 0.5, 0.75, 1],
                  outputRange: [0, b.sway, 0, -b.sway, 0],
                }),
              },
              // Swells a touch as it rises, like a bubble nearing the surface.
              { scale: anims[i].interpolate({ inputRange: [0, 1], outputRange: [0.82, 1.08] }) },
            ],
          }]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // White-on-gradient works on any saturated card (orange settings, red plus):
  // fill 0.20 with a 0.75 rim on a slightly heavier stroke — raising the fill
  // alone would make them read as milky blobs instead.
  bubble: {
    position: 'absolute',
    backgroundColor: 'rgba(255,255,255,0.20)',
    borderWidth: 1.2,
    borderColor: 'rgba(255,255,255,0.75)',
  },
});
