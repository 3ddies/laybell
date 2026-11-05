import { memo, useEffect, useMemo, useRef } from 'react';
import { View, StyleSheet, Animated, Easing } from 'react-native';

// A decorative animated equalizer — a row of bars rising and falling, anchored at the
// bottom. Native-driver only: each bar is full-height inside an overflow-hidden column
// and slides DOWN to appear shorter (the same bottom-anchored trick as the TrackRow
// meter), so nothing animates layout. pointerEvents none — it's background art.
//
// Used as the motion on the premium gate page (PremiumGateHost): music-native, and it
// lives low on the screen so it never crowds the badge/title in the middle.
function EqBars({ color = 'rgba(255,255,255,0.4)', count = 22, height = 220, style }: {
  color?: string;
  count?: number;
  height?: number;
  style?: any;
}) {
  // Per-bar motion, fixed once so re-renders don't reshuffle the field: how short it
  // dips, how tall it peaks, how fast, and a starting phase so they never move in lockstep.
  const bars = useMemo(() => Array.from({ length: count }, () => ({
    low: 0.16 + Math.random() * 0.22,
    high: 0.68 + Math.random() * 0.32,
    dur: 480 + Math.random() * 560,
    delay: Math.random() * 600,
    phase: Math.random(),
  })), [count]);
  const anims = useRef(bars.map((b) => new Animated.Value(b.phase))).current;

  useEffect(() => {
    const loops = anims.map((v, i) => {
      const b = bars[i];
      const leg = (to: number) => Animated.timing(v, { toValue: to, duration: b.dur, easing: Easing.inOut(Easing.quad), useNativeDriver: true });
      const loop = Animated.loop(Animated.sequence([Animated.delay(b.delay), leg(1), leg(0)]));
      loop.start();
      return loop;
    });
    return () => loops.forEach((l) => l.stop());
  }, [anims, bars]);

  return (
    <View pointerEvents="none" style={[styles.row, style]}>
      {bars.map((b, i) => (
        <View key={i} style={[styles.col, { height }]}>
          <Animated.View
            style={{
              height,
              borderTopLeftRadius: 3,
              borderTopRightRadius: 3,
              backgroundColor: color,
              transform: [{
                translateY: anims[i].interpolate({
                  inputRange: [0, 1],
                  outputRange: [height * (1 - b.low), height * (1 - b.high)],
                }),
              }],
            }}
          />
        </View>
      ))}
    </View>
  );
}

export default memo(EqBars);

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 10 },
  col: { flex: 1, overflow: 'hidden', justifyContent: 'flex-end', marginHorizontal: 2 },
});
