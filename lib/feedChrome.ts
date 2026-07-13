import { Animated, Easing } from 'react-native';

// Reactive chrome for the Home/Explore/Music feeds — the floating Laybell
// header (top) and the tab bar + mini player (bottom).
//
// BOTH bars are now DISCRETE, fire-and-forget native glides. STRUCTURAL: the
// header used to be a 1:1 scroll follow driven by a JS setValue per scroll
// event — which meant ANY JS-thread stall (image decode, GC, a React commit
// anywhere in the app) froze it mid-motion. That read as chop at slow/medium
// scroll speeds no matter how many scroll events arrived, and no tuning could
// fix it: the mechanism itself coupled header motion to JS-thread health,
// frame by frame. Now scroll events only pick a STATE (shown/hidden) and a
// native-driver timing performs the motion on the UI thread — it physically
// cannot stutter, exactly like the bottom bar's existing glide.
//
//   TOP bar (header): TRAVEL-gated. Accumulated downward travel past
//     TOP_HIDE_TRAVEL glides it away at any speed (slow reading scrolls still
//     tuck it, preserving the old "scroll past it" spirit); any real upward
//     travel (TOP_SHOW_TRAVEL) or nearing the top glides it back.
//   BOTTOM bar: SPEED-gated both ways (owner-tuned) — only a distinctly hard,
//     fast DOWN-flick condenses it into the circle icons, and only a fast
//     up-flick brings it back.
//
// `feedChrome` (bottom) and `feedChromeTop` (header) are native-driver values
// (0 = shown, 1 = hidden).

export const feedChrome = new Animated.Value(0);     // bottom tab bar (+ mini player)
export const feedChromeTop = new Animated.Value(0);  // Home header

let botValue = 0;
feedChrome.addListener(({ value }) => { botValue = value; });

let lastY = 0;
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
// Gate velocity is measured over ≥12ms windows on its own anchor: coalesced
// scroll events can measure dt far below the real inter-event interval while
// carrying a full frame's dy — apparent velocity inflated severalfold, which
// would spuriously trip these owner-tuned thresholds on gentle scrolls.
const GATE_WINDOW_MS = 12;
let gateY = 0;
let gateT = 0;

// TOP header travel gates: how much accumulated travel in one direction flips
// its state. Hide needs a deliberate scroll-down; show needs a REAL upward
// scroll (owner-tuned resistance: a small correction while reading must not
// pop the header back — the old resolver committed to shown only past ~73px).
const TOP_HIDE_TRAVEL = 90;  // px of accumulated downward travel → hide
const TOP_SHOW_TRAVEL = 64;  // px of accumulated upward travel → show
let topTravel = 0;           // signed accumulator; resets on direction change / new drag

const EASE = Easing.out(Easing.cubic);
let botGliding = false;

function glideBottom(to: 0 | 1) {
  if (botGliding || botValue === to) return;
  botGliding = true;
  Animated.timing(feedChrome, { toValue: to, duration: 380, easing: EASE, useNativeDriver: true }).start(() => { botGliding = false; });
}

// Header glide — dedupe by TARGET (not in-flight state) so a direction change
// mid-glide reverses immediately; retargeting an Animated.timing on the same
// value auto-stops the previous one.
let topTarget: 0 | 1 = 0;
function glideTop(to: 0 | 1) {
  if (topTarget === to) return;
  topTarget = to;
  Animated.timing(feedChromeTop, { toValue: to, duration: 260, easing: EASE, useNativeDriver: true }).start();
}

function stopBottomGlide() {
  if (botGliding) { feedChrome.stopAnimation(); botGliding = false; }
}

// Settle fallback: if the feed goes quiet with the bottom bar mid-transition,
// it snaps back to the full bar (see settleFeedChrome — a partial hide never
// sticks). LAZY timer: momentum frames only stamp lastScrollActivityAt; one
// pending timeout re-checks and re-arms with the remainder.
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
  topTravel = 0;      // each gesture decides the header state on its own travel
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
}

/** Feed onScrollEndDrag — momentum may still follow. */
export function feedDragEnd(): void {
  dragging = false;
  scheduleSettle();
}

/** Feed onScroll. `maxY` (contentSize - viewport, when the caller has it) lets
 *  the header ignore BOTTOM rubber-band overscroll — the spring-back emits
 *  upward-motion frames that would otherwise count as "scrolling up" and pop
 *  the hidden header back in at the end of the feed. */
export function trackFeedScroll(y: number, maxY?: number): void {
  if (suppressed) return; // stale momentum from a tab we've already left
  const now = Date.now();
  if (anchorNext) { anchorNext = false; lastY = y; gateY = y; gateT = now; return; }
  const dy = y - lastY;
  lastY = y;
  if (!dragging) scheduleSettle();

  // ── TOP bar (header): discrete travel-gated glide (see header comment) ──
  if (y < 60) {
    // Near the top the header is always shown (also neutralizes TOP overscroll).
    topTravel = 0;
    glideTop(0);
  } else if (maxY != null && maxY > 60 && y > maxY - 1) {
    // Past the scrollable end (bottom rubber-band) — no travel accrues, so the
    // bounce-back can't read as an intentional scroll-up.
    topTravel = 0;
  } else if (dy !== 0) {
    if (topTravel !== 0 && (dy > 0) !== (topTravel > 0)) topTravel = 0; // direction change restarts the count
    topTravel += dy;
    if (topTravel > TOP_HIDE_TRAVEL) glideTop(1);
    else if (topTravel < -TOP_SHOW_TRAVEL) glideTop(0);
  }

  // ── BOTTOM bar: speed-gated BOTH ways — a hard fast down-flick condenses it to
  // the circles, a hard fast up-flick brings the full bar back. A slow/short
  // read-scroll leaves it exactly where it is (owner: shouldn't collapse easily).
  if (y < 60) {
    // Near the top the bottom bar always comes back.
    bottomArmed = false;
    bottomHideArmed = false;
    gateY = y; gateT = now;
    glideBottom(0);
    return;
  }
  // Direction changes cancel pending arms immediately (per event, as before).
  if (dy > 0) bottomArmed = false;          // scrolling down cancels a pending reveal
  else if (dy < 0) bottomHideArmed = false; // scrolling up cancels a pending collapse
  // Arming decisions use the windowed velocity (see GATE_WINDOW_MS above), and
  // only when the window's net direction agrees with the current event's — a
  // reversal inside the window must never arm anything.
  const gdt = now - gateT;
  if (gdt >= GATE_WINDOW_MS) {
    const gdy = y - gateY;
    const v = (Math.abs(gdy) / gdt) * 1000; // px per second over the window
    // Only a distinctly hard, fast down-flick condenses the bar (any distance) —
    // a gentle read-scroll never arms it, so the full bar stays put.
    if (gdy > 0 && dy > 0 && !bottomHideArmed && v >= BOTTOM_HIDE_VELOCITY) bottomHideArmed = true;
    // Only a distinctly fast up-flick brings the full bar back (any distance).
    else if (gdy < 0 && dy < 0 && !bottomArmed && v >= BOTTOM_REVEAL_VELOCITY) bottomArmed = true;
    gateY = y; gateT = now;
  }
  if (dy > 0 && bottomHideArmed) glideBottom(1);
  else if (dy < 0 && bottomArmed) glideBottom(0);
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
  stopBottomGlide();
  if (botValue !== to) {
    Animated.timing(feedChrome, { toValue: to, duration: 300, easing: EASE, useNativeDriver: true }).start();
  }
  glideTop(to);
}

export function isFeedChromeHidden(): boolean {
  return botValue > 0.5;
}

// Spreadable handler bundle for any vertical scrollable that should drive the
// reactive chrome (Home feed, Explore grid, Music lists).
export const chromeScrollProps = {
  onScroll: (e: { nativeEvent: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } } }) =>
    trackFeedScroll(e.nativeEvent.contentOffset.y, e.nativeEvent.contentSize.height - e.nativeEvent.layoutMeasurement.height),
  onScrollBeginDrag: feedDragStart,
  onScrollEndDrag: feedDragEnd,
  onMomentumScrollEnd: settleFeedChrome,
  // 16 is deliberate: the chrome is DISCRETE now (state picks + native glides),
  // so nothing needs per-frame JS events — 60Hz sampling halves the JS work per
  // scroll frame vs throttle 1, leaving headroom for cell mounts. (Do not "fix"
  // this back to 1; the old 1:1 header follow that needed it is gone.)
  scrollEventThrottle: 16,
} as const;
