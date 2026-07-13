import { createContext, useContext, useSyncExternalStore } from 'react';

// ── Pager swipe state (module store, NOT React state) ───────────────────────
// True while a tab swipe gesture is in progress (between the navigator's
// swipeStart and swipeEnd events). Screens use this to defer work that
// shouldn't happen mid-swipe — e.g. autoplaying feed videos until the page
// settles, or letting the post caption input grab focus (which pops the
// keyboard) when a finger drags across it.
//
// Deliberately a subscription store instead of React state held in the tabs
// layout: state there re-rendered the ENTIRE navigator (screenOptions,
// listeners, tab bar closure) at every swipe start AND end — a re-render storm
// racing the native pager at exactly the moment fast successive swipes were
// getting dropped. With the store, only components that actually call
// usePagerSwiping() re-render; the navigator host doesn't.
let swipingNow = false;
let lastSwipeEndAt = 0;
const SWIPE_TAP_GRACE_MS = 200;
const swipeSubs = new Set<() => void>();

function subscribeSwiping(cb: () => void): () => void {
  swipeSubs.add(cb);
  return () => { swipeSubs.delete(cb); };
}

// Called by the tabs layout from the navigator's swipeStart/swipeEnd events.
export function noteTabSwipe(active: boolean) {
  if (!active) lastSwipeEndAt = Date.now();
  if (swipingNow === active) return;
  swipingNow = active;
  swipeSubs.forEach((cb) => cb());
}

export function usePagerSwiping(): boolean {
  return useSyncExternalStore(subscribeSwiping, () => swipingNow);
}

// Raw store access for OTHER module stores that need to fold the swipe flag
// into their own derived state without a React hook (see lib/feedVideo.ts).
export function subscribePagerSwiping(cb: () => void): () => void {
  return subscribeSwiping(cb);
}
export function getPagerSwiping(): boolean {
  return swipingNow;
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
export function isSwipeTap(): boolean {
  return swipingNow || Date.now() - lastSwipeEndAt < SWIPE_TAP_GRACE_MS;
}

export function guardPress(fn?: () => void): (() => void) | undefined {
  if (!fn) return undefined;
  return () => { if (isSwipeTap()) return; fn(); };
}
