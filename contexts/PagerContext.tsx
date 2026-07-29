import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import { useIsFocused } from '@react-navigation/native';

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

// ── Search lock ──────────────────────────────────────────────────────────────
// While a search field is in use, a horizontal page swipe is almost certainly
// accidental — the user is typing at a keyboard that covers half the screen,
// not navigating. Screens raise this lock and the tabs layout folds it into
// swipeEnabled, exactly the way Listen mode is folded in.
//
// REF-COUNTED, deliberately, where TabSwipeContext is a single boolean slot.
// That slot is already written by Music's dwell rule, its rail guards and the
// profile stepper; a fourth independent writer would fight them (whoever wrote
// last wins, so releasing one lock could silently re-enable swipes another
// still needed). A counter composes instead: swipes return only when EVERY
// holder has let go.
let searchLocks = 0;
const searchLockSubs = new Set<() => void>();

function emitSearchLock() { searchLockSubs.forEach((cb) => cb()); }
function subscribeSearchLock(cb: () => void): () => void {
  searchLockSubs.add(cb);
  return () => { searchLockSubs.delete(cb); };
}

export function getSearchLocked(): boolean { return searchLocks > 0; }

export function useSearchLocked(): boolean {
  return useSyncExternalStore(subscribeSearchLock, getSearchLocked, getSearchLocked);
}

/**
 * Hold the page-swipe lock while `active` AND this screen is focused.
 *
 * The focus half is not optional: the tab navigator keeps every tab screen
 * MOUNTED, so a query left sitting in Explore would otherwise keep the lock
 * raised while the user was over on Music — swipes dead app-wide until they
 * went back and cleared a field they had forgotten about.
 *
 * The release also runs on unmount, so a screen closed mid-search can never
 * strand the pager locked — the failure mode that would make the app feel
 * broken rather than polished.
 */
export function useSearchSwipeLock(active: boolean) {
  const focused = useIsFocused();
  const hold = active && focused;
  useEffect(() => {
    if (!hold) return;
    searchLocks += 1;
    emitSearchLock();
    return () => {
      searchLocks = Math.max(0, searchLocks - 1);
      emitSearchLock();
    };
  }, [hold]);
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
