import { useRef } from 'react';
import { Animated, PanResponder } from 'react-native';

// Rubber-band: approaches `max` asymptotically as drag increases.
function rubber(drag: number, max = 38): number {
  return max * (1 - Math.exp(-drag / max));
}

// Page-level elastic wrapper. Intended for screens that contain FlatLists or
// ScrollViews — places where a sibling PanResponder would lose the gesture to
// the native scroll view in background/empty areas.
//
// Strategy: claim the touch on start (onStartShouldSetPanResponder: true) but
// set onShouldBlockNativeResponder: false so the scroll view's native gesture
// recogniser can ALSO run simultaneously. That means:
//   • Vertical moves  → FlatList scrolls normally (native wins its axis)
//   • Horizontal moves → we apply elastic translateX (no native horizontal action)
//   • Taps on items   → native tap recogniser fires normally; our responder
//                       just sees zero movement and springs back to 0
export default function ElasticPageView({ children, style }: {
  children: React.ReactNode;
  style?: any;
}) {
  const translateX = useRef(new Animated.Value(0)).current;

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onShouldBlockNativeResponder: () => false,
    onPanResponderMove: (_, g) => {
      // Only apply elastic for clearly horizontal intent (2:1 dx/dy ratio,
      // minimum 4 px so tiny finger wobbles don't trigger it).
      if (Math.abs(g.dx) > Math.abs(g.dy) * 2 && Math.abs(g.dx) > 4) {
        translateX.setValue(Math.sign(g.dx) * rubber(Math.abs(g.dx)));
      }
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
      Animated.spring(translateX, {
        toValue: 0,
        useNativeDriver: true,
        bounciness: 3,
        speed: 20,
      }).start();
    },
  })).current;

  return (
    <Animated.View
      style={[style, { transform: [{ translateX }] }]}
      {...pan.panHandlers}
    >
      {children}
    </Animated.View>
  );
}
