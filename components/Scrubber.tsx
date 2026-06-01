import { View, StyleSheet, PanResponder } from 'react-native';
import { useRef, useState } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS, GRADIENTS } from '../constants/theme';

// A draggable progress scrubber. Uses absolute pageX against the bar's measured
// window position (not PanResponder locationX, which is unreliable across gestures).
export default function Scrubber({
  progress, onSeek, height = 20, trackHeight = 4, thumbSize = 14,
}: {
  progress: number;            // 0..1
  onSeek: (ratio: number) => void;
  height?: number; trackHeight?: number; thumbSize?: number;
}) {
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  const ref = useRef<View>(null);
  const layout = useRef({ x: 0, w: 0 });
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;

  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  const measure = () => ref.current?.measureInWindow((x, _y, w) => { layout.current = { x, w }; setWidth(w); });
  const ratioFor = (pageX: number) => clamp((pageX - layout.current.x) / (layout.current.w || 1));

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: e => setDrag(ratioFor(e.nativeEvent.pageX)),
      onPanResponderMove: e => setDrag(ratioFor(e.nativeEvent.pageX)),
      onPanResponderRelease: e => { onSeekRef.current(ratioFor(e.nativeEvent.pageX)); setDrag(null); },
      onPanResponderTerminate: e => { onSeekRef.current(ratioFor(e.nativeEvent.pageX)); setDrag(null); },
    })
  ).current;

  const shown = drag != null ? drag : clamp(progress);
  const thumbLeft = Math.max(0, Math.min(width - thumbSize, shown * width - thumbSize / 2));

  return (
    <View ref={ref} onLayout={measure} style={[styles.area, { height }]} {...pan.panHandlers}>
      <View style={[styles.track, { height: trackHeight, borderRadius: trackHeight / 2 }]}>
        <LinearGradient
          colors={GRADIENTS.primaryWarm}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
          style={{ width: `${shown * 100}%`, height: '100%' }}
        />
      </View>
      <View
        style={[styles.thumb, {
          width: thumbSize, height: thumbSize, borderRadius: thumbSize / 2,
          top: (height - thumbSize) / 2, left: thumbLeft,
        }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  area: { width: '100%', justifyContent: 'center' },
  track: { width: '100%', backgroundColor: COLORS.border, overflow: 'hidden' },
  thumb: { position: 'absolute', backgroundColor: COLORS.text, borderWidth: 2, borderColor: COLORS.primary },
});
