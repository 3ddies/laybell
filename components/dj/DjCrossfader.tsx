import { memo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, runOnJS } from 'react-native-reanimated';

// Horizontal crossfader: drag the thumb A↔B. Reports 0..1 (0 = full A, 1 = full B)
// to the engine's equal-power crossfade. Starts centred.
type Props = { onChange: (x: number) => void; colorA: string; colorB: string };
const THUMB = 36;

export default memo(function DjCrossfader({ onChange, colorA, colorB }: Props) {
  const width = useSharedValue(0);
  const x = useSharedValue(0.5);
  const emit = (v: number) => onChange(v);

  const pan = Gesture.Pan().onUpdate((e) => {
    const w = width.value;
    if (w <= 0) return;
    let t = e.x / w;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    x.value = t;
    runOnJS(emit)(t);
  });

  const thumbStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value * (width.value - THUMB) }] }));

  return (
    <View style={styles.wrap}>
      <View style={styles.labels}>
        <Text style={[styles.side, { color: colorA }]}>A</Text>
        <Text style={styles.title}>CROSSFADER</Text>
        <Text style={[styles.side, { color: colorB }]}>B</Text>
      </View>
      <GestureDetector gesture={pan}>
        <View style={styles.track} onLayout={(e) => { width.value = e.nativeEvent.layout.width; }}>
          <View style={styles.rail} />
          <Animated.View style={[styles.thumb, thumbStyle]} />
        </View>
      </GestureDetector>
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  labels: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4 },
  side: { fontSize: 13, fontWeight: '900' },
  title: { color: '#6F6F79', fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
  track: { height: 46, justifyContent: 'center' },
  rail: { height: 6, borderRadius: 3, backgroundColor: '#242429' },
  thumb: {
    position: 'absolute', width: THUMB, height: 40, borderRadius: 9,
    backgroundColor: '#E8E8EC', borderWidth: 2, borderColor: '#B4B4BC',
  },
});
