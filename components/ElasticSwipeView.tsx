import { useEffect, useRef } from 'react';
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
export default function ElasticSwipeView({ children, style, disabled = false }: {
  children: React.ReactNode;
  style?: any;
  // Suppress the elastic swipe entirely (e.g. while the content is pinch-zoomed,
  // so a zoom-pan doesn't rubber-band the whole view and reveal black edges).
  disabled?: boolean;
}) {
  const translateX = useRef(new Animated.Value(0)).current;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  // When zoom takes over, stop any in-flight rubber-band spring and zero the
  // offset — a running/settled native-animated transform here otherwise composites
  // with the zoom's own native pan and makes it stutter.
  useEffect(() => {
    if (disabled) { translateX.stopAnimation(); translateX.setValue(0); }
  }, [disabled, translateX]);

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onStartShouldSetPanResponderCapture: () => false,
    // 12px (not 6): a page swipe that starts with a slight sideways flick was
    // getting claimed by the rubber-band, blocking the vertical pager for the
    // whole gesture ("my swipe did nothing"). Real horizontal wobbles still
    // clear 12px easily.
    onMoveShouldSetPanResponder: (_e, g) =>
      !disabledRef.current
      && Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 4,
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

  // While disabled (content pinch-zoomed), render WITHOUT the animated transform
  // AND without the pan responder — so neither a lingering native transform nor
  // the RN PanResponder competes with the zoom's RNGH gestures (the cause of the
  // choppy zoomed-pan after a prior swipe). Same element type either way, so the
  // video/children never remount.
  return (
    <Animated.View
      style={[style, disabled ? null : { transform: [{ translateX }] }]}
      {...(disabled ? null : pan.panHandlers)}
    >
      {children}
    </Animated.View>
  );
}
