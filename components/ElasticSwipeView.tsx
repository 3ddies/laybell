import { useRef } from 'react';
import { Animated, PanResponder } from 'react-native';

// Asymptotic rubber-band: approaches `max` displacement as drag → ∞.
// At drag = max, result ≈ 0.63 * max (the curve flattens past that).
function rubber(drag: number, max = 38): number {
  return max * (1 - Math.exp(-drag / max));
}

// Wraps any content and gives horizontal rubber-band feedback when the user
// swipes left or right but that gesture doesn't map to an action in the parent.
// Only claims clearly horizontal gestures (4:1 dx/dy ratio, min 6 px dx) so it
// co-exists safely with surrounding vertical FlatLists and scroll views.
export default function ElasticSwipeView({ children, style }: {
  children: React.ReactNode;
  style?: any;
}) {
  const translateX = useRef(new Animated.Value(0)).current;

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onStartShouldSetPanResponderCapture: () => false,
    onMoveShouldSetPanResponder: (_e, g) =>
      Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy) * 4,
    onMoveShouldSetPanResponderCapture: () => false,
    onPanResponderMove: (_e, g) => {
      translateX.setValue(Math.sign(g.dx) * rubber(Math.abs(g.dx)));
    },
    onPanResponderRelease: () => {
      Animated.spring(translateX, {
        toValue: 0,
        useNativeDriver: true,
        bounciness: 7,
        speed: 18,
      }).start();
    },
    onPanResponderTerminate: () => {
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 3, speed: 20 }).start();
    },
  })).current;

  return (
    <Animated.View style={[style, { transform: [{ translateX }] }]} {...pan.panHandlers}>
      {children}
    </Animated.View>
  );
}
