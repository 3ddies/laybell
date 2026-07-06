import { Animated, Easing } from 'react-native';

// Instagram-style reactive chrome for the Home feed, with per-bar rules
// (owner-tuned):
//
//   HIDING (both bars): FOLLOWS any downward scroll 1:1 over ~210px —
//     speed-agnostic, the morph is literally your gesture.
//   REVEALING: gated on upward speed. Crossing REVEAL_VELOCITY doesn't start
//     delta-following (at fling speeds that completed in a few frames and
//     read as a POP) — it triggers ONE smooth decelerating glide to shown,
//     the same easing family as the settle, so up feels as fluid as down.
//     • bottom bar: glides as soon as the gesture arms, finger down or not.
//     • top bar:    glides only after release (flick-and-release).
//
// Two native-driver values (0 = shown, 1 = hidden): `feedChrome` drives the
// tab bar + music bar, `feedChromeTop` drives the header. Mirrors stay true
// through glides via value listeners.

export const feedChrome = new Animated.Value(0);     // bottom tab bar (+ mini player)
export const feedChromeTop = new Animated.Value(0);  // Home header

let botValue = 0;
let topValue = 0;
// Keep the JS mirrors accurate even while timing animations drive the values.
feedChrome.addListener(({ value }) => { botValue = value; });
feedChromeTop.addListener(({ value }) => { topValue = value; });

let lastY = 0;
let lastT = 0;
let dragging = false;
// Re-anchor on each new drag: different scrollables (Home feed, Explore grid,
// Music lists) share this tracker, so the first frame of a new gesture must
// only record its position — never compute a delta against another list's.
let anchorNext = true;
// After a programmatic reset (tab change, swipe, tap-to-top) the tracker goes
// DEAF until the next real finger drag: the previous tab's list keeps emitting
// momentum scroll frames after it's offscreen, and without this those frames
// would re-condense the bar on the new tab (the "carried over" glitch).
let suppressed = false;

const HIDE_DISTANCE = 210;
// Deliberately HIGH bar: the condensed chips are a clean resting state with no
// urgency to leave, so bringing the bar back takes an intentional hard flick
// (casual and even brisk up-scrolls stay full-bleed). Nearing the top of the
// feed, tapping Home, or changing tabs always restores it regardless.
const REVEAL_VELOCITY = 1800; // px/s of upward motion that arms the reveal
const EASE = Easing.out(Easing.cubic);
let revealArmed = false;
let botGliding = false;
let topGliding = false;

function glideIn(av: Animated.Value, which: 'bot' | 'top') {
  const current = which === 'bot' ? botValue : topValue;
  const gliding = which === 'bot' ? botGliding : topGliding;
  if (gliding || current === 0) return;
  if (which === 'bot') botGliding = true; else topGliding = true;
  Animated.timing(av, { toValue: 0, duration: 380, easing: EASE, useNativeDriver: true }).start(() => {
    if (which === 'bot') botGliding = false; else topGliding = false;
  });
}

function stopGlides() {
  if (botGliding) { feedChrome.stopAnimation(); botGliding = false; }
  if (topGliding) { feedChromeTop.stopAnimation(); topGliding = false; }
}

// Settle fallback: momentum frames keep refreshing this timer; if the feed
// goes quiet the chrome still eases to its nearest edges.
let settleTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSettle() {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(settleFeedChrome, 160);
}

/** Feed onScrollBeginDrag. */
export function feedDragStart(): void {
  dragging = true;
  anchorNext = true;
  suppressed = false; // a real finger drag re-arms tracking after a reset
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
}

/** Feed onScrollEndDrag — momentum may still follow. */
export function feedDragEnd(): void {
  dragging = false;
  // A gesture that armed the reveal while dragging releases the header now.
  if (revealArmed) glideIn(feedChromeTop, 'top');
  scheduleSettle();
}

/** Feed onScroll. */
export function trackFeedScroll(y: number): void {
  if (suppressed) return; // stale momentum from a tab we've already left
  const now = Date.now();
  if (anchorNext) { anchorNext = false; lastY = y; lastT = now; return; }
  const dt = Math.min(100, Math.max(1, now - lastT));
  lastT = now;
  const dy = y - lastY;
  lastY = y;
  if (!dragging) scheduleSettle();
  // Near the top there's nothing to reclaim — glide fully shown.
  if (y < 60) {
    revealArmed = false;
    glideIn(feedChrome, 'bot');
    glideIn(feedChromeTop, 'top');
    return;
  }
  if (dy > 0) {
    // Downward: cancel any in-flight reveal and FOLLOW into hiding.
    revealArmed = false;
    stopGlides();
    feedChrome.setValue(Math.min(1, botValue + dy / HIDE_DISTANCE));
    feedChromeTop.setValue(Math.min(1, topValue + dy / HIDE_DISTANCE));
  } else if (dy < 0) {
    const upVelocity = (-dy / dt) * 1000; // px per second
    if (!revealArmed && upVelocity >= REVEAL_VELOCITY) revealArmed = true;
    if (!revealArmed) return; // slow drift up → everything stays put
    glideIn(feedChrome, 'bot');
    if (!dragging) glideIn(feedChromeTop, 'top');
  }
}

/** Scroll came to rest — ease each bar to its own nearest edge. */
export function settleFeedChrome(): void {
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
  revealArmed = false;
  if (!botGliding && botValue !== 0 && botValue !== 1) {
    Animated.timing(feedChrome, { toValue: botValue > 0.5 ? 1 : 0, duration: 320, easing: EASE, useNativeDriver: true }).start();
  }
  if (!topGliding && topValue !== 0 && topValue !== 1) {
    Animated.timing(feedChromeTop, { toValue: topValue > 0.5 ? 1 : 0, duration: 320, easing: EASE, useNativeDriver: true }).start();
  }
}

/** Programmatic show/hide of BOTH bars (tab changes, tap-to-top, swipes). */
export function setFeedChromeHidden(next: boolean): void {
  const to = next ? 1 : 0;
  revealArmed = false;
  suppressed = true; // ignore leftover momentum until the next real drag
  stopGlides();
  if (botValue !== to) {
    Animated.timing(feedChrome, { toValue: to, duration: 300, easing: EASE, useNativeDriver: true }).start();
  }
  if (topValue !== to) {
    Animated.timing(feedChromeTop, { toValue: to, duration: 300, easing: EASE, useNativeDriver: true }).start();
  }
}

export function isFeedChromeHidden(): boolean {
  return botValue > 0.5;
}

// Spreadable handler bundle for any vertical scrollable that should drive the
// reactive chrome (Home feed, Explore grid, Music lists).
export const chromeScrollProps = {
  onScroll: (e: { nativeEvent: { contentOffset: { y: number } } }) => trackFeedScroll(e.nativeEvent.contentOffset.y),
  onScrollBeginDrag: feedDragStart,
  onScrollEndDrag: feedDragEnd,
  onMomentumScrollEnd: settleFeedChrome,
  scrollEventThrottle: 16,
} as const;
