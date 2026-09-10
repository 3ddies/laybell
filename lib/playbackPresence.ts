import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { createPresence } from './presenceCore';

// The app's single presence clock — see lib/presenceCore.ts for why video needs
// to know whether anybody is still here.
//
// Fed from two places:
//   • every touch, observed at the root in app/_layout.tsx (onTouchStart, which
//     watches without joining gesture negotiation, so it cannot steal a swipe);
//   • the app returning to the foreground. Somebody unlocked the phone — that is
//     presence even before their first tap, and without it a video resumed on
//     return would play one pass and stop.

/**
 * Untouched for this long, looping video finishes its current pass and stops.
 *
 * Five minutes in production: comfortably longer than anyone watches the same
 * short clip repeat without so much as a scroll, and short enough that a phone
 * left on a loop costs one pass plus five minutes instead of all night. Never
 * cuts a first play short — only the NEXT repeat is withheld.
 *
 * ONE MINUTE IN DEV BUILDS, so the behaviour can be checked on a phone without a
 * five-minute wait per attempt. The first on-device test came back "it still
 * loops" with no way to tell a too-short wait from a real fault. __DEV__ is false
 * in every EAS production build, so this cannot ship — and the console announces
 * which value is live when the app starts, so nobody mistakes one for the other.
 */
export const LOOP_IDLE_MS = __DEV__ ? 60_000 : 5 * 60_000;

/**
 * Laybell TV's autoplay-next asks "Still watching?" after this long untouched.
 *
 * An hour in production — lean-back TV is legitimately touch-free, and an hour
 * sits in the range the streaming services settled on. Two minutes in dev
 * builds, for the same reason as LOOP_IDLE_MS.
 */
export const TV_IDLE_MS = __DEV__ ? 2 * 60_000 : 60 * 60_000;

const presence = createPresence(LOOP_IDLE_MS, {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
});

/**
 * A human did something. Wraps the core only so a dev build can explain itself:
 * a touch arriving after a long quiet stretch is precisely the event that keeps a
 * loop running when it "should" have stopped, so that one is logged. Ordinary
 * touches during use are not, or the log would be nothing but scrolling.
 */
export function markInteraction(): void {
  const quietFor = presence.msSinceInteraction();
  presence.markInteraction();
  if (__DEV__ && quietFor >= LOOP_IDLE_MS / 3) {
    // eslint-disable-next-line no-console
    console.log(`[presence] touch after ${Math.round(quietFor / 1000)}s quiet — idle clock reset`);
  }
}

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
});

if (__DEV__) {
  // eslint-disable-next-line no-console
  console.log(`[presence] dev build — looping video stops after ${LOOP_IDLE_MS / 1000}s untouched (5 min in production)`);
  presence.subscribe(() => {
    // eslint-disable-next-line no-console
    console.log(`[presence] ${presence.isIdle() ? 'IDLE — looping video will stop after its current pass' : 'back — looping resumes'}`);
  });
}

/** Re-renders the caller only when the room goes idle or someone comes back. */
export function useLoopIdle(): boolean {
  return useSyncExternalStore(presence.subscribe, presence.isIdle);
}
