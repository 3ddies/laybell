import { createContext, useCallback, useContext, useMemo, useRef } from 'react';
import { Animated, type NativeSyntheticEvent, type NativeScrollEvent } from 'react-native';

// Drives the bottom tab bar's "presence" from content scrolling: scroll DOWN and
// the bar fluidly tucks away (less present); scroll UP (or reach the top) and it
// slides back (more present). One shared Animated.Value lives here; the TabBar
// reads it (transform + opacity, native-driven) and every scrollable screen feeds
// it via `onScroll`. `hidden`: 0 = fully present, 1 = tucked away.

type TabBarScrollValue = {
  hidden: Animated.Value;
  onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  reveal: () => void;
};

// Fallback so a stray consumer outside the provider is a no-op, not a crash.
const fallbackHidden = new Animated.Value(0);
const TabBarScrollContext = createContext<TabBarScrollValue | null>(null);

export function useTabBarScroll(): TabBarScrollValue {
  return useContext(TabBarScrollContext) ?? { hidden: fallbackHidden, onScroll: () => {}, reveal: () => {} };
}

export function TabBarScrollProvider({ children }: { children: React.ReactNode }) {
  const hidden = useRef(new Animated.Value(0)).current;
  const lastY = useRef(0);
  const target = useRef(0);
  // After a reveal (e.g. tab switch), the next scroll event only re-syncs lastY —
  // so landing on a mid-scrolled screen doesn't read a huge phantom delta.
  const resync = useRef(false);

  const animateTo = useCallback((to: number) => {
    if (target.current === to) return;
    target.current = to;
    Animated.timing(hidden, { toValue: to, duration: 220, useNativeDriver: true }).start();
  }, [hidden]);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    if (resync.current) {
      resync.current = false;
      lastY.current = y;
      if (y <= 6) animateTo(0);
      return;
    }
    const dy = y - lastY.current;
    lastY.current = y;
    if (y <= 6) { animateTo(0); return; }   // at/near the top → fully present
    if (dy > 6) animateTo(1);               // scrolling down → tuck away
    else if (dy < -6) animateTo(0);         // scrolling up → bring back
  }, [animateTo]);

  const reveal = useCallback(() => { resync.current = true; animateTo(0); }, [animateTo]);

  const value = useMemo(() => ({ hidden, onScroll, reveal }), [hidden, onScroll, reveal]);
  return <TabBarScrollContext.Provider value={value}>{children}</TabBarScrollContext.Provider>;
}
