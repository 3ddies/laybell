import { Animated, Easing } from 'react-native';

// Instagram-style reactive chrome for the Home/Explore/Music feeds, with
// per-bar rules (owner-tuned):
//
//   HIDING: the BOTTOM bar follows any downward scroll 1:1 over ~210px —
//     speed-agnostic, the morph is literally your gesture. The TOP bar (Home
//     header) is BINARY: once hiding meaningfully starts it SPRINGS fully
//     out — it never rests midway (a half-shifted header reads as a bug).
//   REVEALING: deliberately hard to trigger — casual up-scrolls happen all
//     the time and shouldn't cost the full-bleed view. Arming needs BOTH a
//     fast upward velocity AND sustained upward travel in the same gesture
//     (a soft/short flick spikes speed for a frame but covers no distance).
//     Once armed: the bottom bar glides in smoothly; the header springs in
//     after release (flick-and-release).
//
// `feedChrome` (bottom bar + music bar) and `feedChromeTop` (header) are both
// native-driver values (0 = shown, 1 = hidden). Mirrors stay true via value
// listeners.

export const feedChrome = new Animated.Value(0);     // bottom tab bar (+ mini player)
export const feedChromeTop = new Animated.Value(0);  // Home header

let botValue = 0;
let topValue = 0;
feedChrome.addListener(({ value }) => { botValue = value; });
feedChromeTop.addListener(({ value }) => { topValue = value; });

let lastY = 0;
let lastT = 0;
let dragging = false;
// Re-anchor on each new drag: different scrollables share this tracker, so a
// new gesture's first frame must never compute a delta against another list's.
let anchorNext = true;
// After a programmatic reset (tab change, swipe, tap-to-top) the tracker goes
// DEAF until the next real finger drag — the previous tab's list keeps
// emitting momentum frames after it's offscreen.
let suppressed = false;

const HIDE_DISTANCE = 210;
// Reveal arming: BOTH conditions, same gesture. Casual/short up-flicks fail
// the travel bar; slow deliberate up-scrolls fail the velocity bar.
const REVEAL_VELOCITY = 1800; // px/s upward
const REVEAL_TRAVEL = 90;     // sustained upward px
let revealArmed = false;
let upTravel = 0;

const EASE = Easing.out(Easing.cubic);
let botGliding = false;

function glideBottom(to: 0 | 1) {
  if (botGliding || botValue === to) return;
  botGliding = true;
  Animated.timing(feedChrome, { toValue: to, duration: 380, easing: EASE, useNativeDriver: true }).start(() => { botGliding = false; });
}

// The header is strictly two-state: it springs the whole way, every time.
let topTarget: 0 | 1 = 0;
function springTop(to: 0 | 1) {
  if (topTarget === to) return;
  topTarget = to;
  Animated.spring(feedChromeTop, {
    toValue: to,
    tension: 90,
    friction: 11,
    overshootClamping: true,
    useNativeDriver: true,
  }).start();
}

function stopBottomGlide() {
  if (botGliding) { feedChrome.stopAnimation(); botGliding = false; }
}

// Settle fallback: momentum frames keep refreshing this timer; if the feed
// goes quiet the bottom bar still eases to its nearest edge (the header is
// always already heading to an edge).
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
  upTravel = 0;
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
}

/** Feed onScrollEndDrag — momentum may still follow. */
export function feedDragEnd(): void {
  dragging = false;
  // A gesture that armed the reveal while dragging releases the header now.
  if (revealArmed) springTop(0);
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
  // Near the top there's nothing to reclaim — everything comes back.
  if (y < 60) {
    revealArmed = false;
    upTravel = 0;
    glideBottom(0);
    springTop(0);
    return;
  }
  if (dy > 0) {
    // Downward: the bottom bar FOLLOWS into hiding; the header springs fully
    // out the moment hiding meaningfully starts (binary, never midway).
    revealArmed = false;
    upTravel = 0;
    stopBottomGlide();
    feedChrome.setValue(Math.min(1, botValue + dy / HIDE_DISTANCE));
    if (botValue >= 0.18) springTop(1);
  } else if (dy < 0) {
    const upVelocity = (-dy / dt) * 1000; // px per second
    upTravel += -dy;
    if (!revealArmed && upVelocity >= REVEAL_VELOCITY && upTravel >= REVEAL_TRAVEL) {
      revealArmed = true;
    }
    if (!revealArmed) return; // soft or short up-motion → stays full-bleed
    glideBottom(0);
    if (!dragging) springTop(0);
  }
}

/** Scroll came to rest — ease the bottom bar to its nearest edge. */
export function settleFeedChrome(): void {
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
  revealArmed = false;
  upTravel = 0;
  if (!botGliding && botValue !== 0 && botValue !== 1) {
    Animated.timing(feedChrome, { toValue: botValue > 0.5 ? 1 : 0, duration: 320, easing: EASE, useNativeDriver: true }).start();
  }
}

/** Programmatic show/hide of BOTH bars (tab changes, tap-to-top, swipes). */
export function setFeedChromeHidden(next: boolean): void {
  const to = next ? 1 : 0;
  revealArmed = false;
  upTravel = 0;
  suppressed = true; // ignore leftover momentum until the next real drag
  stopBottomGlide();
  if (botValue !== to) {
    Animated.timing(feedChrome, { toValue: to, duration: 300, easing: EASE, useNativeDriver: true }).start();
  }
  springTop(to);
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
