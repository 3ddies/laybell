import { useEffect, useRef, type ReactNode } from 'react';
import { View, StyleSheet } from 'react-native';
import PagerView from 'react-native-pager-view';
import { useRouter } from 'expo-router';
import { useNavigation } from '@react-navigation/native';

// One-motion swipe-back for pushed screens, matching the tab pager's feel.
// The route must be declared as a transparentModal with animation:'none' and a
// transparent contentStyle (see app/_layout.tsx): page 0 here has NO
// background, so dragging the content right reveals the real previous screen
// under the finger — and by the time the page settles and the route pops, the
// content is already fully off-screen, so the pop is invisible.
//
// The pager drives EVERY motion so they're all the same native pager
// animation the tabs use:
//  - enter: the route appears instantly (animation 'none', see-through) and
//    the pager slides the content in from the right. iOS ignores
//    slide_from_right on modal presentations (it slides up from the bottom
//    instead), which is why the entry can't be left to the stack.
//  - swipe out: drag right, previous screen revealed live, invisible pop.
//  - back button / hardware back: intercepted via beforeRemove, the page
//    slides off first, then the original action is dispatched.
//
// Render the WHOLE screen (header included) as children so the page moves as
// one piece, and keep the route's native back gesture off in app/_layout.tsx —
// this pager owns the horizontal swipe (it arbitrates natively with vertical
// scrolling, which is exactly why the stack's fullScreenGestureEnabled isn't
// used; see the profile pager for the original pattern).
type Props = {
  children: ReactNode;
  // Inner horizontal scrollers (e.g. the slideshow carousel) flip this off
  // while they're being touched so their swipe doesn't also drag the page.
  scrollEnabled?: boolean;
  // Off for screens that run their own entrance (the post viewer grows out of
  // the tapped thumbnail) — the pager then starts on the content page.
  animateIn?: boolean;
  // Replaces the default router.back() once the page is dismissed — the post
  // viewer passes a pop that bypasses its shrink-to-thumbnail close (that
  // animation would run entirely off-screen and just delay the pop). Screens
  // with an onClose also keep their own beforeRemove choreography, so the
  // back-press interception above is skipped for them.
  onClose?: () => void;
};

export default function SwipeBackPager({ children, scrollEnabled = true, animateIn = true, onClose }: Props) {
  const router = useRouter();
  const navigation = useNavigation<any>();
  const pagerRef = useRef<PagerView>(null);
  // False until the content page has settled once — filters out the initial
  // page-0 position report when entering (so it isn't mistaken for a dismiss).
  const armed = useRef(!animateIn);
  const requestedEntry = useRef(false);
  // Set when we initiate the pop ourselves (or a back press is mid-slide-out)
  // so the beforeRemove interception lets the actual removal through.
  const closing = useRef(false);
  const pendingBack = useRef<any>(null);

  // Back button / hardware back: slide the page off first (same motion as the
  // swipe), then let the original navigation action proceed from onPageSelected.
  useEffect(() => {
    if (onClose) return; // screen owns its own close choreography (post viewer)
    const unsub = navigation.addListener('beforeRemove', (e: any) => {
      if (closing.current) return; // our own pop — allow
      e.preventDefault();
      closing.current = true;
      pendingBack.current = e.data.action;
      pagerRef.current?.setPage(0);
    });
    return unsub;
  }, [navigation, onClose]);

  return (
    <PagerView
      ref={pagerRef}
      style={styles.pager}
      initialPage={animateIn ? 0 : 1}
      scrollEnabled={scrollEnabled}
      keyboardDismissMode="on-drag"
      // Entry: start on the see-through page and slide the content in — the
      // route itself appears with no animation, so this IS the push animation.
      onLayout={() => {
        if (!animateIn || requestedEntry.current) return;
        requestedEntry.current = true;
        requestAnimationFrame(() => pagerRef.current?.setPage(1));
      }}
      onPageSelected={(e) => {
        const pos = e.nativeEvent.position;
        if (pos === 1) {
          // Content settled: future page-0 landings are real dismissals. Also
          // treat an interrupted slide-out (grabbed mid-animation) as cancelled.
          armed.current = true;
          closing.current = false;
          pendingBack.current = null;
          return;
        }
        if (pos !== 0) return;
        // A back press already chose the destination — finish that action.
        if (pendingBack.current) { navigation.dispatch(pendingBack.current); return; }
        // Initial position report (or the user dragged back mid-entry) —
        // (re)run the entrance instead of popping.
        if (!armed.current) { pagerRef.current?.setPage(1); return; }
        // Nothing to pop (cold-start deep link) → snap back to the content
        // instead of stranding the user on the see-through page.
        if (!router.canGoBack()) { pagerRef.current?.setPageWithoutAnimation(1); return; }
        closing.current = true;
        if (onClose) onClose();
        else router.back();
      }}
    >
      <View key="dismiss" style={styles.page} collapsable={false} />
      <View key="content" style={styles.page} collapsable={false}>{children}</View>
    </PagerView>
  );
}

// Both pages are deliberately background-free: the dismiss page is the
// see-through gap, and the content page gets its surface from the screen
// itself (its container paints the opaque theme background).
const styles = StyleSheet.create({
  pager: { flex: 1 },
  page: { flex: 1 },
});
