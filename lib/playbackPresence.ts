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
 * Five minutes: comfortably longer than anyone watches the same short clip
 * repeat without so much as a scroll, and short enough that a phone left on a
 * loop costs one pass plus five minutes instead of all night. Never cuts a first
 * play short — only the NEXT repeat is withheld, so a long video always finishes.
 */
export const LOOP_IDLE_MS = 5 * 60_000;

/**
 * Laybell TV's autoplay-next asks "Still watching?" after this long untouched.
 *
 * Far longer than LOOP_IDLE_MS because lean-back TV is legitimately touch-free —
 * nobody taps a phone every five minutes while watching a television. An hour
 * sits in the same range the streaming services settled on.
 */
export const TV_IDLE_MS = 60 * 60_000;

const presence = createPresence(LOOP_IDLE_MS, {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
});

export const markInteraction = presence.markInteraction;
export const msSinceInteraction = presence.msSinceInteraction;
export const isLoopIdle = presence.isIdle;

// 'active' specifically, not merely "not background": the transient 'inactive'
// of a notification pull-down is not someone coming back to the app.
AppState.addEventListener('change', (s) => { if (s === 'active') presence.markInteraction(); });

if (__DEV__) {
  presence.subscribe(() => {
    // eslint-disable-next-line no-console
    console.log(`[presence] ${presence.isIdle() ? 'IDLE — looping video will stop after its current pass' : 'back — looping resumes'}`);
  });
}

/** Re-renders the caller only when the room goes idle or someone comes back. */
export function useLoopIdle(): boolean {
  return useSyncExternalStore(presence.subscribe, presence.isIdle);
}
