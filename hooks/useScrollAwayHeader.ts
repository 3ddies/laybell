import { useCallback, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { useSharedValue, useAnimatedScrollHandler, useAnimatedStyle } from 'react-native-reanimated';

/**
 * A single profile header that scrolls away as the active tab's feed scrolls —
 * the Instagram / Home-story-rail feel. It is rendered ONCE (it carries
 * StorybookShelf, which runs a per-instance focus effect + ensureAutoRecaps, so
 * it must never be duplicated across the tab bodies) as an absolute layer that
 * translates up in lockstep with scroll.
 *
 * The scroll is read with Reanimated's useAnimatedScrollHandler and the transform
 * with useAnimatedStyle, so BOTH run on the UI thread: the header tracks the
 * finger with zero lag, on 60Hz and 120Hz alike. (The earlier core-Animated
 * version drove the value over the JS bridge, which trailed a frame; and a
 * native-driver Animated.event on a plain list throws "_c.call is not a
 * function" — Reanimated avoids both.) The bodies must therefore be Reanimated
 * animated components: Reanimated.ScrollView, and Reanimated.createAnimatedComponent(FlashList).
 *
 * Per-tab scroll: every tab body keeps its own independent scroll offset, so each
 * gets its own shared value + handler. The header binds to whichever tab is
 * active, so switching tabs shows it at that body's remembered position with no
 * cross-tab bleed. The feed reserves the header's height via contentContainer
 * paddingTop, and an overflow:hidden wrapper around [header + pager] clips the
 * header at the nav bar.
 *
 * Usage (both profile screens):
 *   const AnimatedFlashList = Reanimated.createAnimatedComponent(FlashList);
 *   const h = useScrollAwayHeader(TAB_KEYS, activeTab);
 *   <View style={{ flex: 1, overflow: 'hidden' }}>
 *     <Reanimated.View onLayout={h.onOverlayLayout} style={[styles.headerOverlay, h.headerStyle]}>
 *       {card}{tabStrip}
 *     </Reanimated.View>
 *     <Pager>{ each body: <AnimatedFlashList | Reanimated.ScrollView>
 *              onScroll={h.onScrollForTab(key)} scrollEventThrottle={16}
 *              contentContainerStyle={[styles.pageContent, { paddingTop: h.overlayH }]} }</Pager>
 *   </View>
 */
export function useScrollAwayHeader(tabKeys: readonly string[], activeTab: string) {
  // One UI-thread scroll value + one scroll handler per tab body. TAB_KEYS is a
  // fixed-length module constant on both profile screens, so these .map()s call
  // the exact same hooks in the same order on every render — the rules-of-hooks
  // lint just can't prove the length is constant, hence the disable.
  /* eslint-disable react-hooks/rules-of-hooks */
  const scrollYs = tabKeys.map(() => useSharedValue(0));
  const handlers = scrollYs.map((sv) =>
    useAnimatedScrollHandler((e) => { sv.value = e.contentOffset.y; }));
  /* eslint-enable react-hooks/rules-of-hooks */

  const [overlayH, setOverlayH] = useState(0);
  const onOverlayLayout = useCallback((e: LayoutChangeEvent) => {
    // Transforms don't affect layout, so this is the header's natural height even
    // while it's translated off-screen.
    const h = e.nativeEvent.layout.height;
    if (h > 0) setOverlayH((prev) => (Math.abs(h - prev) > 0.5 ? h : prev));
  }, []);

  const idx = Math.max(0, tabKeys.indexOf(activeTab));
  const activeSV = scrollYs[idx];
  const headerStyle = useAnimatedStyle(() => {
    const max = overlayH;
    // Clamp to [0, overlayH]: never past the header's own height (the wrapper
    // clips the rest), and never positive (so an overscroll bounce at the top
    // doesn't push the header down).
    const y = activeSV.value < 0 ? 0 : (activeSV.value > max ? max : activeSV.value);
    return { transform: [{ translateY: -y }] };
  }, [activeSV, overlayH]);

  const onScrollForTab = useCallback(
    (key: string) => handlers[Math.max(0, tabKeys.indexOf(key))],
    [handlers, tabKeys],
  );

  return { onScrollForTab, onOverlayLayout, overlayH, headerStyle };
}
