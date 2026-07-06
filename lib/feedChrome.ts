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
let lastT = 0;

// Scroll distance that fully hides/reveals the chrome once motion counts.
const HIDE_DISTANCE = 140;
const SHOW_DISTANCE = 70;

// Instagram's reveal rule: a SLOW upward scroll (drifting back to re-read)
// keeps the chrome hidden — only crossing this upward speed (px/s) arms the
// reveal. Once armed, the chrome follows the finger for the REST of that
// gesture even if it slows, so it never stutters mid-reveal. Scrolling down
// again or the scroll settling disarms it. (650 felt hair-trigger — raised
// per owner so casual up-drifts stay full-bleed and only a real flick reveals.)
const REVEAL_VELOCITY = 1100;
let revealArmed = false;

/** Feed onScroll: the chrome follows the scroll delta proportionally. */
export function trackFeedScroll(y: number): void {
  const now = Date.now();
  const dt = Math.min(100, Math.max(1, now - lastT));
  lastT = now;
  const dy = y - lastY;
  lastY = y;
  // Near the top there's nothing to reclaim — always fully shown.
  if (y < 60) {
    revealArmed = false;
    if (value !== 0) { value = 0; feedChrome.setValue(0); }
    return;
  }
  if (dy > 0) {
    // Downward: always follows (hiding is speed-agnostic), and disarms any
    // in-flight reveal.
    revealArmed = false;
    const next = Math.min(1, value + dy / HIDE_DISTANCE);
    if (next !== value) { value = next; feedChrome.setValue(next); }
  } else if (dy < 0) {
    // Upward: gated on speed — arm only past the velocity threshold.
    const upVelocity = (-dy / dt) * 1000; // px per second
    if (!revealArmed && upVelocity >= REVEAL_VELOCITY) revealArmed = true;
    if (!revealArmed) return; // slow drift up → chrome stays where it is
    const next = Math.max(0, value + dy / SHOW_DISTANCE);
    if (next !== value) { value = next; feedChrome.setValue(next); }
  }
}

/** Scroll came to rest — settle the chrome to the nearest edge. */
export function settleFeedChrome(): void {
  revealArmed = false;
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
