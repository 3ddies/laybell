import { createContext, useContext } from 'react';

// True while a tab swipe gesture is in progress (between the navigator's
// swipeStart and swipeEnd events). Screens use this to defer work that
// shouldn't happen mid-swipe — e.g. autoplaying feed videos until the page
// settles, or letting the post caption input grab focus (which pops the
// keyboard) when a finger drags across it.
export const PagerContext = createContext<boolean>(false);

export function usePagerSwiping() {
  return useContext(PagerContext);
}

// Lets a deep child temporarily turn the tab navigator's swipe off/on — e.g. a
// horizontal slideshow carousel disables it while you swipe between slides so the
// gesture doesn't bubble up and change tabs. Default is a no-op (outside the tabs,
// e.g. the full-screen post viewer, there's no tab swiper to control).
export const TabSwipeContext = createContext<(enabled: boolean) => void>(() => {});

export function useTabSwipeControl() {
  return useContext(TabSwipeContext);
}

// ── Swipe-tap guard ──────────────────────────────────────────────────────────
// The pager must never be blocked — fast consecutive swipes have to register —
// so accidental activations are stopped at the PRESS side instead: swipe-prone
// targets (track rows, post tiles) wrap their handlers in guardPress(), which
// swallows a press that fires during a tab swipe or within a short grace
// window after one ends (a swipe's finger-up can read as a tap on whatever
// slid underneath). Module-level so non-hook code (render callbacks) can read.
let swipingNow = false;
let lastSwipeEndAt = 0;
const SWIPE_TAP_GRACE_MS = 200;

// Called by the tabs layout from the navigator's swipeStart/swipeEnd events.
export function noteTabSwipe(active: boolean) {
  swipingNow = active;
  if (!active) lastSwipeEndAt = Date.now();
}

export function isSwipeTap(): boolean {
  return swipingNow || Date.now() - lastSwipeEndAt < SWIPE_TAP_GRACE_MS;
}

export function guardPress(fn?: () => void): (() => void) | undefined {
  if (!fn) return undefined;
  return () => { if (isSwipeTap()) return; fn(); };
}
