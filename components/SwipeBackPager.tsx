import { useEffect, useRef, type ReactNode } from 'react';
import { View, StyleSheet, Animated, Easing, useWindowDimensions } from 'react-native';
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
//  - enter: the route appears instantly (animation 'none', see-through) and
//    the CONTENT slides in from the right — an Animated slide on the UI
//    thread (native driver), NOT a pager setPage. The old pager-driven entry
//    (mount on blank page 0 → onLayout → rAF → setPage(1)) raced first
//    layout: land early and the page snapped in with no animation at all,
//    land late under JS load and the slide started visibly behind the tap.
//    A native-driver timing started at mount can do neither. Timing matches
//    the measured Instagram push: 280ms, cubic ease-out (fast launch, soft
//    landing), while a scrim dims the previous screen in the shrinking gap —
//    the same depth cue as the iOS push. (iOS ignores slide_from_right on
//    modal presentations, which is why the entry can't be left to the stack.)
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
  // Post/reel viewers: the instant a swipe is committed past halfway, jump the
  // content the rest of the way off and pop — instead of riding the slow native
  // settle, which is long enough that the user could accidentally re-grab the
  // content as it exits.
  fastExit?: boolean;
};

// The measured Instagram push: ~280ms with a hard-decelerating cubic-out
// (a third of the distance covered in the first two frames, feather landing).
const ENTER_MS = 280;
// How dark the previous screen gets once fully covered (iOS push dim).
const SCRIM_MAX = 0.32;

export default function SwipeBackPager({ children, scrollEnabled = true, animateIn = true, onClose, fastExit = false }: Props) {
  const router = useRouter();
  const navigation = useNavigation<any>();
  const { width: screenW } = useWindowDimensions();
  const pagerRef = useRef<PagerView>(null);
  // The pager now ALWAYS starts on the content page — the entrance is the
  // Animated slide below, so there is no blank-page mount to arm against.
  const armed = useRef(true);
  // Live fractional scroll position (0 = dismiss page, 1 = content). Tracked so
  // that if the pager ever comes to rest BETWEEN the two pages, we can snap it to
  // the nearest one. This is the "stuck/bounced halfway" glitch: a near-diagonal
  // swipe gets partly claimed by the screen's vertical ScrollView, which freezes
  // the pager mid-drag and lets it settle at a fractional offset — leaving the
  // view half on the previous screen and half on this one.
  const fraction = useRef(1);
  // Set when we initiate the pop ourselves (or a back press is mid-slide-out)
  // so the beforeRemove interception lets the actual removal through.
  const closing = useRef(false);
  const pendingBack = useRef<any>(null);

  // ── Entrance ────────────────────────────────────────────────────────────────
  // 0 → 1 drives the content's translateX (screenW → 0) AND the scrim. Native
  // driver: the slide runs on the UI thread, so it fires on every push at the
  // same speed no matter what the JS thread is doing.
  const enter = useRef(new Animated.Value(animateIn ? 0 : 1)).current;
  // Mirrors the pager's live fraction (1 = content on screen) so the scrim also
  // tracks the swipe-back: dragging the content away un-dims the previous
  // screen exactly as it's revealed.
  const pagerFrac = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!animateIn) return;
    Animated.timing(enter, {
      toValue: 1,
      duration: ENTER_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const contentTx = enter.interpolate({ inputRange: [0, 1], outputRange: [screenW, 0] });
  const scrimOpacity = Animated.multiply(enter, pagerFrac).interpolate({
    inputRange: [0, 1],
    outputRange: [0, SCRIM_MAX],
  });

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
    <View style={styles.pager}>
      {/* Dims the previous screen behind the see-through gap — rises with the
          entrance slide, falls as a swipe-back reveals it again. */}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, styles.scrim, { opacity: scrimOpacity }]}
      />
    <PagerView
      ref={pagerRef}
      style={styles.pager}
      initialPage={1}
      scrollEnabled={scrollEnabled}
      keyboardDismissMode="on-drag"
      // Keep the live fractional position up to date for the idle re-snap below,
      // and mirrored into the scrim so the dim tracks the finger.
      onPageScroll={(e) => {
        const { position, offset } = e.nativeEvent;
        fraction.current = position + offset;
        pagerFrac.setValue(Math.min(1, Math.max(0, position + offset)));
      }}
      // When the gesture ends and the pager goes idle, it should be sitting exactly
      // on a page. If it stranded between the two (the half-and-half glitch), snap
      // it to the nearest one so it always completes the swipe or cancels cleanly —
      // landing on 0 then runs the normal dismiss path via onPageSelected.
      onPageScrollStateChanged={(e) => {
        const state = e.nativeEvent.pageScrollState;
        // fastExit (post viewer): the moment a committed swipe is released (settling
        // toward the dismiss page 0), jump the content the rest of the way off and
        // let onPageSelected(0) pop — skipping the slow native settle so the exit is
        // snappy and can't be re-grabbed mid-slide. Guards exclude a snap-back to
        // content (fraction < 0.5) and the back-button path.
        if (state === 'settling' && fastExit && armed.current && !closing.current && !pendingBack.current && fraction.current < 0.5) {
          pagerRef.current?.setPageWithoutAnimation(0);
          return;
        }
        if (state !== 'idle') return;
        const f = fraction.current;
        if (f > 0.02 && f < 0.98) pagerRef.current?.setPage(f >= 0.5 ? 1 : 0);
      }}
      onPageSelected={(e) => {
        const pos = e.nativeEvent.position;
        fraction.current = pos; // exact at every settle, so the idle re-snap can't false-fire
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
        // Nothing to pop (cold-start deep link) → snap back to the content
        // instead of stranding the user on the see-through page.
        if (!router.canGoBack()) { pagerRef.current?.setPageWithoutAnimation(1); return; }
        closing.current = true;
        if (onClose) onClose();
        else router.back();
      }}
    >
      <View key="dismiss" style={styles.page} collapsable={false} />
      <View key="content" style={styles.page} collapsable={false}>
        {/* The push: content slides in over the see-through route. */}
        <Animated.View style={[styles.page, { transform: [{ translateX: contentTx }] }]}>
          {children}
        </Animated.View>
      </View>
    </PagerView>
    </View>
  );
}

// Both pages are deliberately background-free: the dismiss page is the
// see-through gap, and the content page gets its surface from the screen
// itself (its container paints the opaque theme background).
const styles = StyleSheet.create({
  pager: { flex: 1 },
  page: { flex: 1 },
  scrim: { backgroundColor: '#000' },
});
