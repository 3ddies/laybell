import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { createPresence, type PresenceClock } from './presenceCore';

// The app's presence clocks — see lib/presenceCore.ts for why video needs to know
// whether anybody is still here.
//
// Two clocks, one signal. Both are fed from the same two places:
//   • every touch, observed at the root in app/_layout.tsx (onTouchStart, which
//     watches without joining gesture negotiation, so it cannot steal a swipe);
//   • the app returning to the foreground. Somebody unlocked the phone — that is
//     presence even before their first tap, and without it a video resumed on
//     return would play one pass and stop.
// They differ only in how long a quiet phone takes to count as an empty room.

/**
 * Untouched for this long, the room counts as empty. Previews pause on the spot;
 * a video somebody opened finishes what is playing and does not repeat — see
 * lib/idleLoopCore.ts for why those two differ.
 *
 * Five minutes in production: comfortably longer than anyone watches the same
 * short clip repeat without so much as a scroll, and short enough that a phone
 * left on a video costs minutes instead of all night.
 *
 * ONE MINUTE IN DEV BUILDS, so the behaviour can be checked on a phone without a
 * five-minute wait per attempt. The first on-device test came back "it still
 * loops" with no way to tell a too-short wait from a real fault. __DEV__ is false
 * in every EAS production build, so this cannot ship — and the console announces
 * which value is live when the app starts, so nobody mistakes one for the other.
 */
export const LOOP_IDLE_MS = __DEV__ ? 60_000 : 5 * 60_000;

/**
 * Lean-back watching is hands-free by nature, so it gets an hour instead: Laybell
 * TV's autoplay-next (AirPlay and Cast) and reels auto-scroll keep rolling until
 * nobody has touched the phone for this long, then stop after what is playing.
 *
 * An hour sits in the range the streaming services settled on, and it is what the
 * owner chose for reels auto-scroll on 2026-09-10: someone watching hands-free sees
 * no change, while a phone left on reels costs about an hour of delivery (~6 cents)
 * instead of all night. Two minutes in dev builds, for the same reason as
 * LOOP_IDLE_MS.
 */
export const LEAN_BACK_IDLE_MS = __DEV__ ? 2 * 60_000 : 60 * 60_000;

const clock: PresenceClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};
const presence = createPresence(LOOP_IDLE_MS, clock);
const leanBack = createPresence(LEAN_BACK_IDLE_MS, clock);

/**
 * A human did something. Wraps the cores only so a dev build can explain itself:
 * a touch arriving after a long quiet stretch is precisely the event that keeps a
 * loop running when it "should" have stopped, so that one is logged. Ordinary
 * touches during use are not, or the log would be nothing but scrolling.
 */
export function markInteraction(): void {
  const quietFor = presence.msSinceInteraction();
  presence.markInteraction();
  leanBack.markInteraction();
  if (__DEV__ && quietFor >= LOOP_IDLE_MS / 3) {
    // eslint-disable-next-line no-console
    console.log(`[presence] touch after ${Math.round(quietFor / 1000)}s quiet — idle clock reset`);
  }
}

// Both clocks are marked together, so either one's reading is the same.
export const msSinceInteraction = presence.msSinceInteraction;
export const isLoopIdle = presence.isIdle;

// 'active' specifically, not merely "not background": the transient 'inactive'
// of a notification pull-down is not someone coming back to the app. Logged in
// dev because a notification banner does briefly cycle the app through
// inactive → active, and that silently counts as presence.
AppState.addEventListener('change', (s) => {
  if (s !== 'active') return;
  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.log(`[presence] app became active after ${Math.round(presence.msSinceInteraction() / 1000)}s — counts as presence`);
  }
  presence.markInteraction();
  leanBack.markInteraction();
});

if (__DEV__) {
  // eslint-disable-next-line no-console
  console.log(`[presence] dev build — previews stop after ${LOOP_IDLE_MS / 1000}s untouched, reels auto-scroll and TV after ${LEAN_BACK_IDLE_MS / 1000}s (5 min and 1 hour in production)`);
  presence.subscribe(() => {
    // eslint-disable-next-line no-console
    console.log(`[presence] ${presence.isIdle()
      ? 'IDLE — previews pause now; opened videos finish what is playing, then stop'
      : 'back — paused previews resume'}`);
  });
  leanBack.subscribe(() => {
    // eslint-disable-next-line no-console
    console.log(`[presence] ${leanBack.isIdle()
      ? 'LEAN-BACK IDLE — reels auto-scroll and TV stop after what is playing'
      : 'lean-back back — reels auto-scroll and TV roll on'}`);
  });
}

/** Re-renders the caller only when the room goes idle or someone comes back. */
export function useLoopIdle(): boolean {
  return useSyncExternalStore(presence.subscribe, presence.isIdle);
}

/** The same, on the one-hour lean-back clock. */
export function useLeanBackIdle(): boolean {
  return useSyncExternalStore(leanBack.subscribe, leanBack.isIdle);
}
