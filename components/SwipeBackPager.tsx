import { useEffect, useRef, type ReactNode } from 'react';
import { View, StyleSheet, Animated, Easing, useWindowDimensions } from 'react-native';
import PagerView from 'react-native-pager-view';
import { useRouter } from 'expo-router';
import { useNavigation } from '@react-navigation/native';
import { useSearchLocked } from '../contexts/PagerContext';

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
//  - back button / hardware back: intercepted via beforeRemove; the content
//    slides off on the SAME Animated value as the entrance (run in reverse,
//    faster and accelerating), then the original action is dispatched. It is
//    deliberately not a pager setPage — that rode the pager's own native settle,
//    which is uncontrollable and about twice as long.
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
  // DYNAMIC — it changes during a gesture.
  scrollEnabled?: boolean;
  // Turns swipe-back off for the whole screen. Deliberately separate from
  // `scrollEnabled`, and expected to be constant for a screen's lifetime: this
  // one decides whether the pager is RENDERED AT ALL, so toggling it mid-life
  // would remount the children. Used where an accidental drag costs something
  // that cannot be undone — a live session, a stream, a half-built form.
  swipeBackEnabled?: boolean;
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
// Leaving is deliberately FASTER than arriving, and accelerates instead of
// decelerating: an entrance should land softly, an exit should get out of the
// way. This used to be `pagerRef.setPage(0)`, i.e. react-native-pager-view's own
// native settle — uncontrollable, ease-in-out, and roughly twice this long, so a
// whole screen took visibly longer to leave than a bottom sheet did. 220ms /
// cubic-in is exactly what every sheet in the app already closes with
// (PostOptions, Share, CommentsSheet, PlaylistOptionsSheet), so screens and
// sheets now leave at one speed instead of two.
const EXIT_MS = 220;
// How dark the previous screen gets once fully covered (iOS push dim).
const SCRIM_MAX = 0.32;

export default function SwipeBackPager({
  children, scrollEnabled = true, swipeBackEnabled = true, animateIn = true, onClose, fastExit = false,
}: Props) {
  const searchLocked = useSearchLocked();
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

  // Back button / hardware back: slide the content off first, then dispatch the
  // original navigation action.
  useEffect(() => {
    if (onClose) return; // screen owns its own close choreography (post viewer)
    const unsub = navigation.addListener('beforeRemove', (e: any) => {
      if (closing.current) return; // our own pop — allow
      e.preventDefault();
      closing.current = true;
      const action = e.data.action;
      // Drive the exit ourselves rather than handing it to the pager. Running
      // `enter` back to 0 is the entrance in reverse — the same native-driver
      // translateX, and the scrim (enter × pagerFrac) un-dims the screen behind
      // as it's revealed, for free. When it lands the content is fully
      // off-screen, so dispatching the original action pops invisibly. The
      // re-entry is guarded by closing.current above.
      Animated.timing(enter, {
        toValue: 0,
        duration: EXIT_MS,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(() => navigation.dispatch(action));
    });
    return unsub;
  }, [navigation, onClose]);

  // SWIPE OFF — and NOT by handing scrollEnabled:false to the pager, which does
  // not work on iOS. Fabric applies that prop with:
  //
  //     if (newScreenProps.scrollEnabled != scrollView.scrollEnabled) { … }
  //
  // and `scrollView` is only bound when the UIPageViewController is built. If
  // props land first it is nil, messaging nil returns NO, so the test reads
  // `false != false`, the assignment is skipped — and because the prop never
  // changes again after mount, updateProps never re-runs to correct it. The
  // pager stays swipeable while the JS looks entirely correct, which is exactly
  // how this shipped once already.
  //
  // So when the swipe is off there is no pager at all. No dismiss page, no
  // gesture to disable, nothing to get wrong natively. The entrance slide and
  // the scrim are unaffected — both live out here — and back-press handling is
  // the beforeRemove listener above, which never touched the pager either.
  if (!swipeBackEnabled) {
    return (
      <View style={styles.pager}>
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, styles.scrim, { opacity: scrimOpacity }]}
        />
        <Animated.View style={[styles.page, { transform: [{ translateX: contentTx }] }]}>
          {children}
        </Animated.View>
      </View>
    );
  }

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
      // A search field in use anywhere holds the lock: a horizontal swipe while
      // typing is almost always accidental, and here it would pop the screen and
      // throw the query away. Read from the shared store rather than plumbed
      // through props, because the search state usually lives in a child (the
      // Shop's Explore tab, for instance) while this pager sits in the parent.
      scrollEnabled={scrollEnabled && !searchLocked}
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
        if (state === 'settling' && fastExit && armed.current && !closing.current && fraction.current < 0.5) {
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
          return;
        }
        if (pos !== 0) return;
        // Only a SWIPE can land here now: a back press never moves the pager,
        // it runs the exit slide above and dispatches its own action.
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
