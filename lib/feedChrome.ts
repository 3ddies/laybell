import { Animated, Easing } from 'react-native';

// Instagram-style reactive chrome for the Home/Explore/Music feeds. The two bars
// behave DIFFERENTLY (owner-tuned):
//
//   TOP bar (Laybell header): a natural SCROLL-PAST follow — it tracks the scroll
//     1:1, sliding up out of view as you scroll DOWN (so it reads as a stationary
//     header you literally scroll past) and back in as you scroll UP, both
//     regardless of speed. It can rest partway (part of the scroll feel, not a
//     spring); speed-agnostic on purpose so it never feels overreactive.
//   BOTTOM bar (tab bar + mini player): SPEED-gated BOTH ways. Only a distinctly
//     hard, fast DOWN-flick condenses it into the circle icons — a slow or short
//     read-scroll leaves the full bar exactly where it is. Coming BACK from the
//     circles is likewise SPEED-gated — only a distinctly fast up-flick reveals it
//     (any distance).
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

// BOTTOM tab bar hide (full bar → circles) is SPEED-gated: only a distinctly hard,
// fast DOWN-flick condenses it — a slow/short read-scroll leaves the full bar in
// place (owner: shouldn't collapse on a gentle scroll). Tune to taste: HIGHER =
// must flick harder/faster to collapse.
const BOTTOM_HIDE_VELOCITY = 5000;   // px/s downward — bottom bar's collapse gate
// BOTTOM tab bar reveal (circles → full bar) is SPEED-gated: only a distinctly
// hard, fast up-flick brings it back (owner: shouldn't come back too easily).
const BOTTOM_REVEAL_VELOCITY = 5670; // px/s upward — bottom bar's speed gate
let bottomArmed = false;             // bottom bar reveal armed this gesture
let bottomHideArmed = false;         // bottom bar collapse armed this gesture

// The Laybell HEADER (top bar) is NOT speed-gated — it tracks the scroll 1:1
// (see trackFeedScroll): up out of view as you scroll down (a stationary header
// you scroll past), back in as you scroll up, at any speed. This is its travel
// distance in px — set to the measured header height so it's a true 1:1 scroll-
// past (defaults to 140 until the header lays out).
let topDistance = 140;
export function setFeedHeaderHeight(h: number): void { if (h > 0) topDistance = h; }

const EASE = Easing.out(Easing.cubic);
let botGliding = false;

function glideBottom(to: 0 | 1) {
  if (botGliding || botValue === to) return;
  botGliding = true;
  Animated.timing(feedChrome, { toValue: to, duration: 380, easing: EASE, useNativeDriver: true }).start(() => { botGliding = false; });
}

// Header spring — used ONLY for programmatic show/hide (tab tap, tap-to-top).
// Scroll-driven header motion goes through trackFeedScroll's 1:1 setValue, so
// there's no state guard here (it would go stale against those setValue writes).
function springTop(to: 0 | 1) {
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

// ── Header "stuck half-open" resolver ────────────────────────────────────────
// The header is a free 1:1 follow, so scrolling can leave it resting partway. A
// half-open header looks unpolished, so if it sits partway for >0.75s (i.e. the
// scroll has stopped mid-transition), it commits to a clean end state. The snap-in
// cutoff is DIRECTIONAL (see topReappearing): if the header was DISAPPEARING it
// snaps fully in from just past 37% down (topValue < 0.63); if it was REAPPEARING
// (scroll-up) it must be more than 52% back (topValue < 0.48) before it commits to
// fully in — otherwise it slides back out. Any scroll cancels it and the follow
// takes back over.
const TOP_SETTLE_MS = 750;
let topSettleTimer: ReturnType<typeof setTimeout> | null = null;
let topSettling = false;
// Whether the header was last moving toward SHOWN (reappearing, i.e. scrolling
// up) vs toward hidden (disappearing). The resolve threshold is DIRECTIONAL:
// reappearing needs the header more than 52% back before it commits to fully in
// (the user is likely just reading posts and doesn't want the bar popping back);
// disappearing keeps the lenient 37% snap-in.
let topReappearing = false;
const SNAP_IN_REAPPEAR = 0.48;  // reappearing → snap in only past 52% back (topValue < 0.48)
const SNAP_IN_DISAPPEAR = 0.63; // disappearing → snap in past 37% down (topValue < 0.63)
function clearTopSettle() {
  if (topSettleTimer) { clearTimeout(topSettleTimer); topSettleTimer = null; }
  if (topSettling) { feedChromeTop.stopAnimation(); topSettling = false; }
}
// Lazy re-check for the resolver above: if the feed scrolled since this check
// was armed, re-arm for the remaining quiet period instead of resolving early.
let topLastScrollAt = 0;
function checkTopSettle() {
  topSettleTimer = null;
  const idleFor = Date.now() - topLastScrollAt;
  if (idleFor < TOP_SETTLE_MS) { topSettleTimer = setTimeout(checkTopSettle, TOP_SETTLE_MS - idleFor); return; }
  settleTopBar();
}
function settleTopBar() {
  topSettleTimer = null;
  if (topValue <= 0.001 || topValue >= 0.999) return; // already resolved
  // Directional: reappearing must be more than 52% back to snap in; disappearing
  // snaps in from just past 37% (see topReappearing).
  const snapIn = topReappearing ? SNAP_IN_REAPPEAR : SNAP_IN_DISAPPEAR;
  const to: 0 | 1 = topValue < snapIn ? 0 : 1; // past threshold → snap in; else slide out
  topSettling = true;
  Animated.timing(feedChromeTop, {
    toValue: to,
    duration: to === 0 ? 200 : 300, // snap down / slide up
    easing: EASE,
    useNativeDriver: true,
  }).start(() => { topSettling = false; });
}

// Settle fallback: if the feed goes quiet with the bottom bar mid-transition,
// it snaps back to the full bar (see settleFeedChrome — a partial hide never
// sticks). LAZY timer: momentum frames only stamp lastScrollActivityAt; one
// pending timeout re-checks and re-arms with the remainder. (The old version
// cleared + recreated the timeout on EVERY scroll frame — measurable JS-thread
// churn during scroll, part of the "staticy" feed feel on iOS.)
const SETTLE_IDLE_MS = 160;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let lastScrollActivityAt = 0;
function scheduleSettle() {
  lastScrollActivityAt = Date.now();
  if (settleTimer) return; // one pending check is enough — it re-arms itself
  settleTimer = setTimeout(checkSettle, SETTLE_IDLE_MS);
}
function checkSettle() {
  settleTimer = null;
  const idleFor = Date.now() - lastScrollActivityAt;
  if (idleFor >= SETTLE_IDLE_MS) { settleFeedChrome(); return; }
  settleTimer = setTimeout(checkSettle, SETTLE_IDLE_MS - idleFor); // scrolled since — wait out the remainder
}

/** Feed onScrollBeginDrag. */
export function feedDragStart(): void {
  dragging = true;
  anchorNext = true;
  suppressed = false; // a real finger drag re-arms tracking after a reset
  clearTopSettle();   // the follow takes back over — cancel any pending resolve
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
}

/** Feed onScrollEndDrag — momentum may still follow. */
export function feedDragEnd(): void {
  dragging = false;
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

  // ── TOP bar (Laybell header): natural scroll-past follow, speed-agnostic ──
  // Tracks the scroll 1:1 — slides up out of view as you scroll DOWN (so it reads
  // as a stationary header you scroll past) and back in as you scroll UP, at any
  // speed. Clamped so it's never hidden by more than you've scrolled from the top
  // (fully shown at rest at the very top). It can come to rest partway, like
  // content — no spring, so it never feels overreactive.
  const nextTop = Math.min(
    Math.max(0, Math.min(1, topValue + dy / topDistance)),
    Math.min(1, Math.max(0, y) / topDistance),
  );
  if (nextTop !== topValue) {
    topReappearing = nextTop < topValue; // moving toward shown = reappearing (scroll up)
    if (topSettling) { feedChromeTop.stopAnimation(); topSettling = false; } // scroll overrides a settle
    feedChromeTop.setValue(nextTop);
  }
  // Arm the "stuck half-open" resolver — LAZY: scroll events just stamp the
  // activity time; one pending timeout re-checks and re-arms with the remainder
  // (see checkTopSettle), so it still only fires ~0.75s after the scroll truly
  // stops with the header partway, without clearing + recreating a timer on
  // every scroll frame. settleTopBar's own guard covers a header that resolved
  // to fully-shown/hidden while the check was pending.
  topLastScrollAt = now;
  if (nextTop > 0 && nextTop < 1 && !topSettleTimer) {
    topSettleTimer = setTimeout(checkTopSettle, TOP_SETTLE_MS);
  }

  // ── BOTTOM bar: speed-gated BOTH ways — a hard fast down-flick condenses it to
  // the circles, a hard fast up-flick brings the full bar back. A slow/short
  // read-scroll leaves it exactly where it is (owner: shouldn't collapse easily).
  if (y < 60) {
    // Near the top the bottom bar always comes back.
    bottomArmed = false;
    bottomHideArmed = false;
    glideBottom(0);
    return;
  }
  if (dy > 0) {
    bottomArmed = false; // scrolling down cancels a pending reveal
    const downVelocity = (dy / dt) * 1000; // px per second
    // Only a distinctly hard, fast down-flick condenses the bar (any distance) —
    // a gentle read-scroll never arms it, so the full bar stays put.
    if (!bottomHideArmed && downVelocity >= BOTTOM_HIDE_VELOCITY) bottomHideArmed = true;
    if (bottomHideArmed) glideBottom(1);
  } else if (dy < 0) {
    bottomHideArmed = false; // scrolling up cancels a pending collapse
    const upVelocity = (-dy / dt) * 1000; // px per second
    // Only a distinctly fast up-flick brings the full bar back (any distance).
    if (!bottomArmed && upVelocity >= BOTTOM_REVEAL_VELOCITY) bottomArmed = true;
    if (bottomArmed) glideBottom(0);
  }
}

/** Scroll came to rest. A PARTIAL hide (the bottom bar was dragged part-way
 *  toward the circle icons but not all the way) always snaps BACK to the full
 *  bottom bar — the condense only sticks if the hide gesture completed (botValue
 *  reached 1 during the scroll). So the bar never rests mid-transition. */
export function settleFeedChrome(): void {
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
  bottomArmed = false;
  bottomHideArmed = false;
  if (!botGliding && botValue !== 0 && botValue !== 1) {
    Animated.timing(feedChrome, { toValue: 0, duration: 320, easing: EASE, useNativeDriver: true }).start();
  }
}

/** Programmatic show/hide of BOTH bars (tab changes, tap-to-top, swipes). */
export function setFeedChromeHidden(next: boolean): void {
  const to = next ? 1 : 0;
  bottomArmed = false;
  bottomHideArmed = false;
  suppressed = true; // ignore leftover momentum until the next real drag
  clearTopSettle();  // programmatic spring below owns the header now
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
