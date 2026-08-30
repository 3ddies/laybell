import AsyncStorage from '@react-native-async-storage/async-storage';

// "Swipe sideways for the next video" — the one-off teaching note for the
// landscape reel pager.
//
// The gesture is invisible: turning the phone gets you a fullscreen video, and
// nothing about that says another one is a swipe away. So the hint exists for
// people who have not found it yet, and for nobody else. Everything here is
// about making sure it stops:
//
//   • Three times in a lifetime, ever.
//   • Once a day at most, so two of those three can never land in one sitting.
//   • Retired outright the moment someone swipes, because that is proof they
//     already know — a hint that keeps teaching a lesson already learned reads
//     as the app not paying attention.
//
// The caller adds the timing rules (twenty seconds of uninterrupted playback,
// or ten seconds paused) — this file only answers whether it is allowed at all.

const KEY = 'laybell.hint.landscapeSwipe.v1';
const MAX_SHOWS = 3;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

type State = { count: number; lastAt: number };

// Read once per app run. The gate is checked each time landscape opens, and a
// storage round trip per rotation to re-learn a number we already hold is waste.
let cached: State | null = null;

async function read(): Promise<State> {
  if (cached) return cached;
  let s: State = { count: 0, lastAt: 0 };
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<State>;
      // Coerced, not trusted: a value corrupted into a NaN would compare false
      // against every bound and quietly turn the cap off.
      s = { count: Number(p?.count) || 0, lastAt: Number(p?.lastAt) || 0 };
    }
  } catch {
    // Unreadable or unparseable storage → treat as a fresh user. Erring toward
    // showing a hint three times is the harmless direction.
  }
  cached = s;
  return s;
}

async function write(s: State): Promise<void> {
  cached = s;
  try { await AsyncStorage.setItem(KEY, JSON.stringify(s)); } catch { /* in-memory still holds for this run */ }
}

/** Whether the hint may appear at all: under the lifetime cap, past the daily wait. */
export async function canShowLandscapeSwipeHint(): Promise<boolean> {
  const s = await read();
  if (s.count >= MAX_SHOWS) return false;
  // A clock moved backwards would otherwise park the hint until the date caught
  // up; treating any future stamp as "due" keeps it recoverable.
  const since = Date.now() - s.lastAt;
  return since >= COOLDOWN_MS || since < 0;
}

/** It was shown. Spends one of the three and starts the day's wait. */
export async function noteLandscapeSwipeHintShown(): Promise<void> {
  const s = await read();
  await write({ count: s.count + 1, lastAt: Date.now() });
}

/**
 * The user swiped sideways under their own power. They know the gesture, so the
 * remaining allowance is spent rather than saved — this is a hint, not a quota.
 */
export async function retireLandscapeSwipeHint(): Promise<void> {
  const s = await read();
  if (s.count >= MAX_SHOWS) return;
  await write({ count: MAX_SHOWS, lastAt: s.lastAt });
}
