import { View, StyleSheet, PanResponder, Animated } from 'react-native';
import { useEffect, useRef, useState } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';

const clamp = (n: number) => Math.max(0, Math.min(1, n));

// A draggable progress scrubber. Uses absolute pageX vs the bar's measured
// window position, and an Animated value so playback glides smoothly between
// status updates and dragging doesn't re-render the parent.
export default function Scrubber({
  progress, onSeek, height = 20, trackHeight = 4, thumbSize = 14,
}: {
  progress: number;            // 0..1
  onSeek: (ratio: number) => void;
  height?: number; trackHeight?: number; thumbSize?: number;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [width, setWidth] = useState(0);
  const ref = useRef<View>(null);
  const layout = useRef({ x: 0, w: 0 });
  const anim = useRef(new Animated.Value(0)).current;
  const dragging = useRef(false);
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;

  // Glide toward the playback position when not actively dragging.
  useEffect(() => {
    if (dragging.current) return;
    Animated.timing(anim, { toValue: clamp(progress), duration: 240, useNativeDriver: false }).start();
  }, [progress]);

  const measure = () => ref.current?.measureInWindow((x, _y, w) => { layout.current = { x, w }; setWidth(w); });
  const ratioFor = (pageX: number) => clamp((pageX - layout.current.x) / (layout.current.w || 1));

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: e => { dragging.current = true; anim.stopAnimation(); anim.setValue(ratioFor(e.nativeEvent.pageX)); },
      onPanResponderMove: e => anim.setValue(ratioFor(e.nativeEvent.pageX)),
      onPanResponderRelease: e => { const r = ratioFor(e.nativeEvent.pageX); anim.setValue(r); dragging.current = false; onSeekRef.current(r); },
      onPanResponderTerminate: e => { const r = ratioFor(e.nativeEvent.pageX); anim.setValue(r); dragging.current = false; onSeekRef.current(r); },
    })
  ).current;

  const fillWidth = anim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
  const thumbLeft = anim.interpolate({ inputRange: [0, 1], outputRange: [0, Math.max(0, width - thumbSize)] });

  return (
    <View ref={ref} onLayout={measure} style={[styles.area, { height }]} {...pan.panHandlers}>
      <View style={[styles.track, { height: trackHeight, borderRadius: trackHeight / 2 }]}>
        <Animated.View style={{ width: fillWidth, height: '100%', overflow: 'hidden' }}>
          {/* Fixed-width gradient revealed by the animated mask, so it doesn't stretch */}
          <LinearGradient
            colors={GRADIENTS.primaryWarm}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
            style={{ width: width || 1, height: '100%' }}
          />
        </Animated.View>
      </View>
      <Animated.View
        style={[styles.thumb, {
          width: thumbSize, height: thumbSize, borderRadius: thumbSize / 2,
          top: (height - thumbSize) / 2, left: thumbLeft,
        }]}
      />
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  area: { width: '100%', justifyContent: 'center' },
  track: { width: '100%', backgroundColor: colors.border, overflow: 'hidden' },
  thumb: { position: 'absolute', backgroundColor: colors.text, borderWidth: 2, borderColor: colors.primary },
});
