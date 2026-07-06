import { Animated } from 'react-native';

// Instagram/Twitter-style reactive chrome for the Home feed. The chrome value
// FOLLOWS the scroll 1:1 (0 = fully shown, 1 = fully hidden): a slow drag
// tucks the header/bar away gradually under your finger, a fast fling sweeps
// them off instantly — speed comes from the gesture, not a canned animation.
// When the scroll settles, the chrome snaps to whichever edge it's nearest.
//
// One shared native-driver Animated.Value: the Home header and the tab bar
// both interpolate their own translate off it, so they move in lockstep.

export const feedChrome = new Animated.Value(0);

// Mirror of the animated value (Animated.Value has no sync read).
let value = 0;
let lastY = 0;

// Scroll distance that fully hides/reveals the chrome. Revealing is ~2×
// as eager as hiding (IG feel: hide lazily, come back the moment you look up).
const HIDE_DISTANCE = 140;
const SHOW_DISTANCE = 70;

/** Feed onScroll: the chrome follows the scroll delta proportionally. */
export function trackFeedScroll(y: number): void {
  const dy = y - lastY;
  lastY = y;
  // Near the top there's nothing to reclaim — always fully shown.
  if (y < 60) {
    if (value !== 0) { value = 0; feedChrome.setValue(0); }
    return;
  }
  // Ignore bounce/overscroll artifacts (huge negative jumps from scrollToOffset
  // are fine — they reveal, which is always safe).
  const next = Math.max(0, Math.min(1, value + dy / (dy > 0 ? HIDE_DISTANCE : SHOW_DISTANCE)));
  if (next !== value) {
    value = next;
    feedChrome.setValue(next);
  }
}

/** Scroll came to rest — settle the chrome to the nearest edge. */
export function settleFeedChrome(): void {
  if (value === 0 || value === 1) return;
  const to = value > 0.5 ? 1 : 0;
  value = to;
  Animated.timing(feedChrome, { toValue: to, duration: 140, useNativeDriver: true }).start();
}

/** Programmatic show/hide (tab changes, tap-to-top, swipes). */
export function setFeedChromeHidden(next: boolean): void {
  const to = next ? 1 : 0;
  if (value === to) return;
  value = to;
  Animated.timing(feedChrome, { toValue: to, duration: 200, useNativeDriver: true }).start();
}

export function isFeedChromeHidden(): boolean {
  return value > 0.5;
}
