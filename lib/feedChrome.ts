import { Animated } from 'react-native';

// Instagram-style reactive chrome for the Home feed, with per-bar reveal rules
// (owner-tuned):
//
//   HIDING (both bars): follows any downward scroll 1:1, speed-agnostic.
//   BOTTOM BAR reveal:  upward motion past REVEAL_VELOCITY — finger down or
//                       momentum, doesn't matter — then follows the gesture.
//   TOP BAR reveal:     ONLY on a flick-and-release. While the finger is on
//                       the screen the header stays tucked no matter how fast
//                       the drag is; it comes back during the momentum phase
//                       (after release) of a fast upward flick.
//
// Two native-driver values (0 = shown, 1 = hidden): `feedChrome` drives the
// tab bar, `feedChromeTop` drives the header. They hide together and settle
// independently to their nearest edge when scrolling rests.

export const feedChrome = new Animated.Value(0);     // bottom tab bar
export const feedChromeTop = new Animated.Value(0);  // Home header

// Mirrors (Animated.Value has no sync read).
let botValue = 0;
let topValue = 0;
let lastY = 0;
let lastT = 0;
let dragging = false;

const HIDE_DISTANCE = 140;
const SHOW_DISTANCE = 70;

// Upward speed (px/s) that arms revealing. Slow drifts never reveal.
const REVEAL_VELOCITY = 1100;
let revealArmed = false;

function setBot(v: number) { if (v !== botValue) { botValue = v; feedChrome.setValue(v); } }
function setTop(v: number) { if (v !== topValue) { topValue = v; feedChromeTop.setValue(v); } }

// Settle fallback: momentum frames keep refreshing this timer; if the feed
// goes quiet (drag ended with no fling, or momentum died without the end
// event), the chrome still snaps to its nearest edges.
let settleTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSettle() {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(settleFeedChrome, 160);
}

/** Feed onScrollBeginDrag. */
export function feedDragStart(): void {
  dragging = true;
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
}

/** Feed onScrollEndDrag — momentum may still follow. */
export function feedDragEnd(): void {
  dragging = false;
  scheduleSettle();
}

/** Feed onScroll: the chrome follows the scroll delta proportionally. */
export function trackFeedScroll(y: number): void {
  const now = Date.now();
  const dt = Math.min(100, Math.max(1, now - lastT));
  lastT = now;
  const dy = y - lastY;
  lastY = y;
  if (!dragging) scheduleSettle();
  // Near the top there's nothing to reclaim — always fully shown.
  if (y < 60) {
    revealArmed = false;
    setBot(0);
    setTop(0);
    return;
  }
  if (dy > 0) {
    // Downward: both bars follow into hiding; any in-flight reveal disarms.
    revealArmed = false;
    const next = Math.min(1, botValue + dy / HIDE_DISTANCE);
    setBot(next);
    setTop(Math.min(1, topValue + dy / HIDE_DISTANCE));
  } else if (dy < 0) {
    const upVelocity = (-dy / dt) * 1000; // px per second
    if (!revealArmed && upVelocity >= REVEAL_VELOCITY) revealArmed = true;
    if (!revealArmed) return; // slow drift up → everything stays put
    // Bottom bar: follows the armed gesture, finger down or not.
    setBot(Math.max(0, botValue + dy / SHOW_DISTANCE));
    // Top bar: flick-and-RELEASE only — follows solely during momentum.
    if (!dragging) setTop(Math.max(0, topValue + dy / SHOW_DISTANCE));
  }
}

/** Scroll came to rest — settle each bar to its own nearest edge. */
export function settleFeedChrome(): void {
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
  revealArmed = false;
  if (botValue !== 0 && botValue !== 1) {
    const to = botValue > 0.5 ? 1 : 0;
    botValue = to;
    Animated.timing(feedChrome, { toValue: to, duration: 140, useNativeDriver: true }).start();
  }
  if (topValue !== 0 && topValue !== 1) {
    const to = topValue > 0.5 ? 1 : 0;
    topValue = to;
    Animated.timing(feedChromeTop, { toValue: to, duration: 140, useNativeDriver: true }).start();
  }
}

/** Programmatic show/hide of BOTH bars (tab changes, tap-to-top, swipes). */
export function setFeedChromeHidden(next: boolean): void {
  const to = next ? 1 : 0;
  revealArmed = false;
  if (botValue !== to) {
    botValue = to;
    Animated.timing(feedChrome, { toValue: to, duration: 200, useNativeDriver: true }).start();
  }
  if (topValue !== to) {
    topValue = to;
    Animated.timing(feedChromeTop, { toValue: to, duration: 200, useNativeDriver: true }).start();
  }
}

export function isFeedChromeHidden(): boolean {
  return botValue > 0.5;
}
