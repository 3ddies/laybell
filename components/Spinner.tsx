import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';

// A smooth, continuously-rotating ring spinner — a faint full circle with one
// brighter leading arc. Reads as fluid/iOS rather than the segmented native
// ActivityIndicator (which looks rigid/Android). Native-driver rotation, so it
// spins on the UI thread even while JS is busy decoding the story.
export default function Spinner({ size = 34, color = '#fff', thickness = 3 }: {
  size?: number; color?: string; thickness?: number;
}) {
  const spin = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 850, easing: Easing.linear, useNativeDriver: true }),
    );
    anim.start();
    return () => anim.stop();
  }, [spin]);

  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: thickness,
        borderColor: color + '2E',   // faint full ring (~18% alpha)
        borderTopColor: color,       // bright leading arc
        transform: [{ rotate }],
      }}
    />
  );
}
