import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Animated, Dimensions, Easing } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useNavigation } from '@react-navigation/native';
import type { SourceRect } from '../lib/stories';

const { width: W, height: H } = Dimensions.get('window');

// Instagram-style shared-element transition for full-screen routes (reel/post/
// story viewers). The opener measures the tapped thumbnail and passes its screen
// rect as a `src` param; this hook animates the screen growing OUT of that rect on
// open and shrinking back INTO it on close (back button, gesture, or hardware
// back — all intercepted). If no `src` is present it no-ops (screen just shows).
//
// Usage in a screen:
//   const { dismiss, backdropOpacity, contentStyle } = useExpandTransition();
//   <View style={{ flex: 1 }}>
//     <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill,
//        { backgroundColor: '#000', opacity: backdropOpacity }]} />
//     <Animated.View style={[StyleSheet.absoluteFill, contentStyle]}>…screen…</Animated.View>
//   </View>
// …and call `dismiss()` from the screen's back button. Set the route to
// presentation:'transparentModal', animation:'none', gestureEnabled:false.
export function useExpandTransition() {
  const router = useRouter();
  const navigation = useNavigation<any>();
  const { src } = useLocalSearchParams<{ src?: string }>();

  const srcRect = useMemo<SourceRect | null>(() => {
    try {
      const p = src ? JSON.parse(src) : null;
      if (p && typeof p.x === 'number' && typeof p.width === 'number') return p;
    } catch {}
    return null;
  }, [src]);

  const expand = useRef(new Animated.Value(srcRect ? 0 : 1)).current;
  // Separate, slower fade so the content eases in on open (not a fast pop). The
  // close fade-out stays driven by `expand` (felt right), so opacity = the two
  // multiplied: open follows this, close follows the expand edge.
  const contentFadeIn = useRef(new Animated.Value(srcRect ? 0 : 1)).current;
  const closingRef = useRef(false);

  useEffect(() => {
    if (srcRect) {
      Animated.timing(expand, { toValue: 1, duration: 360, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
      Animated.timing(contentFadeIn, { toValue: 1, duration: 340, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runClose = useCallback((done: () => void) => {
    if (srcRect) {
      Animated.timing(expand, { toValue: 0, duration: 300, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(done);
    } else {
      done();
    }
  }, [srcRect, expand]);

  // Back button / programmatic close.
  const dismiss = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    runClose(() => router.back());
  }, [runClose, router]);

  // Pop WITHOUT the shrink-back close — for the swipe-back pager, which has
  // already slid the content off-screen (the shrink would run invisibly and
  // just delay the pop). Marks closing so beforeRemove lets the pop through.
  const popInstant = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    router.back();
  }, [router]);

  // Intercept the hardware/gesture back so it shrinks first, then proceeds.
  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', (e: any) => {
      if (closingRef.current || !srcRect) return; // already animating, or no rect → allow
      e.preventDefault();
      closingRef.current = true;
      runClose(() => navigation.dispatch(e.data.action));
    });
    return unsub;
  }, [navigation, srcRect, runClose]);

  // Memoized so a screen re-render (e.g. video progress) doesn't rebuild these
  // interpolation objects mid-animation, which causes the native-driven transform
  // to stutter. `contentOpacity` fades the content out as it reaches the thumbnail
  // so the fully-shrunk rectangle is never visible (and fades in on open).
  const { transform, backdropOpacity, contentOpacity } = useMemo(() => {
    if (!srcRect) {
      return { transform: [] as any[], backdropOpacity: 1 as any, contentOpacity: 1 as any };
    }
    const s0 = srcRect.width / W;
    const tx0 = srcRect.x + srcRect.width / 2 - W / 2;
    const ty0 = srcRect.y + srcRect.height / 2 - H / 2;
    return {
      transform: [
        { translateX: expand.interpolate({ inputRange: [0, 1], outputRange: [tx0, 0] }) },
        { translateY: expand.interpolate({ inputRange: [0, 1], outputRange: [ty0, 0] }) },
        { scale: expand.interpolate({ inputRange: [0, 1], outputRange: [s0, 1] }) },
      ] as any[],
      backdropOpacity: expand as any,
      contentOpacity: Animated.multiply(
        contentFadeIn,
        expand.interpolate({ inputRange: [0, 0.12], outputRange: [0, 1], extrapolate: 'clamp' }),
      ) as any,
    };
  }, [srcRect, expand, contentFadeIn]);

  return { srcRect, dismiss, popInstant, backdropOpacity, contentStyle: { opacity: contentOpacity, transform } };
}
