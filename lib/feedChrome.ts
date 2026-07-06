import { Animated } from 'react-native';

// Instagram/Twitter-style reactive chrome for the Home feed: scrolling DOWN
// tucks the header up and the bottom bar down (more room for content);
// scrolling UP — or landing near the top — brings both back instantly.
//
// One shared native-driver Animated.Value (0 = chrome shown, 1 = hidden):
// the Home header and the tab bar both interpolate their own translate off it,
// so the two move in lockstep from a single timing animation.

export const feedChrome = new Animated.Value(0);

let hidden = false;

export function setFeedChromeHidden(next: boolean): void {
  if (next === hidden) return;
  hidden = next;
  Animated.timing(feedChrome, {
    toValue: next ? 1 : 0,
    duration: 240,
    useNativeDriver: true,
  }).start();
}

export function isFeedChromeHidden(): boolean {
  return hidden;
}

// Scroll-delta tracker: call from the feed's onScroll. Direction changes reset
// the accumulator so a long slow scroll can't get "stuck"; small thresholds
// make the reveal feel eager (Instagram hides lazily, reveals eagerly).
let lastY = 0;
let accum = 0;

export function trackFeedScroll(y: number): void {
  const dy = y - lastY;
  lastY = y;
  // Near the top the chrome is ALWAYS shown (nothing to reclaim up there).
  if (y < 60) { accum = 0; setFeedChromeHidden(false); return; }
  if (Math.sign(dy) !== Math.sign(accum)) accum = 0;
  accum += dy;
  if (accum > 24) setFeedChromeHidden(true);
  else if (accum < -12) setFeedChromeHidden(false);
}
