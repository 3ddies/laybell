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
export default function ElasticSwipeView({ children, style, disabled = false, resetKey }: {
  children: React.ReactNode;
  style?: any;
  // Suppress the elastic swipe entirely (e.g. while the content is pinch-zoomed,
  // so a zoom-pan doesn't rubber-band the whole view and reveal black edges).
  disabled?: boolean;
  // Recycling reset (FlashList reuses instances across items): when the hosted
  // item changes, kill any in-flight rubber-band so it can't carry over.
  resetKey?: string | number;
}) {
  const translateX = useRef(new Animated.Value(0)).current;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const firstResetRef = useRef(true);
  useEffect(() => {
    if (firstResetRef.current) { firstResetRef.current = false; return; }
    translateX.stopAnimation();
    translateX.setValue(0);
  }, [resetKey, translateX]);

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
    //
    // ONE FINGER ONLY. An elastic swipe is a one-finger gesture by definition,
    // and without this it was eating pinches: PanResponder's dx is the CENTROID
    // of all active touches, so spreading two fingers apart horizontally — which
    // is most of what a pinch is — drags the centroid well past 12px with almost
    // no dy. The rubber-band claimed the responder and the card slid sideways
    // instead of the photo zooming. The reel viewer only dodges this by passing
    // `disabled` while zoomed; guarding here fixes it for every host at once.
    onMoveShouldSetPanResponder: (_e, g) =>
      !disabledRef.current
      && g.numberActiveTouches === 1
      && Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 4,
    onMoveShouldSetPanResponderCapture: () => false,
    // Android only (iOS ignores this): DON'T block native containers from
    // intercepting after we claim. On iOS the tab pager's UIScrollView freely
    // steals a horizontal gesture from JS mid-flight — that's why swiping
    // between tabs from a feed card always works there. The RN default here
    // (true) forbids Android's ViewPager2 from doing the same steal, so the
    // card rubber-banded IN PLACE of the tab changing on slower swipes.
    // Yielding restores the iOS contract: the pager takes over when the swipe
    // is really a page change (we get onPanResponderTerminate and spring back),
    // and on surfaces whose pager is vertical (reels) a horizontal drag is
    // never contested, so the rubber-band works exactly as before.
    onShouldBlockNativeResponder: () => false,
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
