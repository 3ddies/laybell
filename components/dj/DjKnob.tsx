import { memo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, runOnJS } from 'react-native-reanimated';

// A DJ knob you control by dragging UP/DOWN (not twisting — far easier on a phone,
// per docs/DJ_BOOTH_SPEC.md §6). The dial is just the readout. A single TAP (no drag)
// snaps it back to `resetTo`. Drives the engine imperatively via onChange, so the audio
// graph never waits on a React render.
type Props = {
  label?: string;
  min?: number;
  max?: number;
  initial?: number;
  /** Double-tap snaps here (usually the neutral/centre value). */
  resetTo?: number;
  onChange: (v: number) => void;
  size?: number;
  color?: string;
};

const SWEEP = 138;        // degrees of travel each side of centre
const TRAVEL_PX = 170;    // finger travel for the full range

export default memo(function DjKnob({
  label, min = -1, max = 1, initial = 0, resetTo = 0, onChange, size = 54, color = '#F26522',
}: Props) {
  const value = useSharedValue(initial);
  const startVal = useSharedValue(initial);
  const emit = (v: number) => onChange(v);

  const pan = Gesture.Pan()
    .onBegin(() => { startVal.value = value.value; })
    .onUpdate((e) => {
      const range = max - min;
      let v = startVal.value - (e.translationY / TRAVEL_PX) * range;
      if (v < min) v = min;
      if (v > max) v = max;
      value.value = v;
      runOnJS(emit)(v);
    });
  // A clean tap (no movement) resets; any drag beats the tap, so adjusting never
  // accidentally snaps to default.
  const tap = Gesture.Tap().onEnd(() => {
    value.value = resetTo;
    runOnJS(emit)(resetTo);
  });
  const gesture = Gesture.Exclusive(tap, pan);

  const dialStyle = useAnimatedStyle(() => {
    const t = (value.value - min) / (max - min); // 0..1
    const angle = -SWEEP + t * (2 * SWEEP);
    return { transform: [{ rotate: `${angle}deg` }] };
  });

  return (
    <View style={styles.wrap}>
      <GestureDetector gesture={gesture}>
        <View style={[styles.knob, { width: size, height: size, borderRadius: size / 2 }]}>
          {/* The whole dial rotates around the knob centre; the notch sits at 12 o'clock. */}
          <Animated.View style={[StyleSheet.absoluteFillObject, styles.dial, dialStyle]}>
            <View style={[styles.notch, { backgroundColor: color, height: size * 0.3 }]} />
          </Animated.View>
          <View style={[styles.cap, { backgroundColor: color }]} />
        </View>
      </GestureDetector>
      {!!label && <Text style={styles.label} numberOfLines={1}>{label}</Text>}
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: 5 },
  knob: {
    backgroundColor: '#1A1A1D', borderWidth: 2, borderColor: '#2E2E34',
    alignItems: 'center', justifyContent: 'center',
  },
  dial: { alignItems: 'center', justifyContent: 'flex-start', paddingTop: 3 },
  notch: { width: 3, borderRadius: 2 },
  cap: { width: 6, height: 6, borderRadius: 3, opacity: 0.9 },
  label: { color: '#8A8A92', fontSize: 10, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase' },
});
