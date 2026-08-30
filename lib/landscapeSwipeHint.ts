import AsyncStorage from '@react-native-async-storage/async-storage';

// "Swipe sideways for the next video" — the teaching note for the landscape reel
// pager. Turning the phone gets you a fullscreen video, and nothing about that
// says another one is a swipe away.
//
// ONE message, TWO appearances, on deliberately different terms:
//
//   • The INTRO, after twenty seconds of settled watching. This is the one that
//     interrupts, so it is rationed hard: three times in a lifetime, one a day.
//   • The PAUSED note, after ten seconds stopped. This interrupts nothing —
//     there is a still frame on screen and someone looking at it — so it is
//     unrationed, and simply appears whenever a pause runs that long.
//
// Both stop dead the first time someone drags the pager sideways under their own
// power. That is proof they know the gesture, and no amount of remaining
// allowance is worth teaching a lesson already learned.

const KEY = 'laybell.hint.landscapeSwipe.v1';
const MAX_INTROS = 3;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

type State = {
  /** Intros shown so far. */
  count: number;
  /** When the last intro was shown. */
  lastAt: number;
  /** The user has swiped the landscape pager by hand at least once. */
  swiped: boolean;
};

// Read once per app run. Both gates are checked on every rotation into
// landscape, and a storage round trip to re-learn numbers already in hand is
// waste on a screen about to start decoding video.
let cached: State | null = null;

async function read(): Promise<State> {
  if (cached) return cached;
  let s: State = { count: 0, lastAt: 0, swiped: false };
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<State>;
      // Coerced, not trusted: a value corrupted into a NaN compares false
      // against every bound and would quietly turn a cap off.
      s = { count: Number(p?.count) || 0, lastAt: Number(p?.lastAt) || 0, swiped: p?.swiped === true };
    }
  } catch {
    // Unreadable or unparseable → treat as a fresh user. Erring toward showing
    // a hint three times is the harmless direction.
  }
  cached = s;
  return s;
}

async function write(s: State): Promise<void> {
  cached = s;
  try { await AsyncStorage.setItem(KEY, JSON.stringify(s)); } catch { /* in-memory still holds for this run */ }
}

/** The rationed one: under the lifetime cap, past the day's wait, never swiped. */
export async function canShowSwipeIntro(): Promise<boolean> {
  const s = await read();
  if (s.swiped || s.count >= MAX_INTROS) return false;
  // A clock moved backwards would otherwise park the hint until the date caught
  // up; treating any future stamp as due keeps it recoverable.
  const since = Date.now() - s.lastAt;
  return since >= COOLDOWN_MS || since < 0;
}

/** The unrationed one. Only ever stopped by the user proving they know. */
export async function canShowPauseHint(): Promise<boolean> {
  return !(await read()).swiped;
}

/** An intro was shown: spends one of the three and starts the day's wait. */
export async function noteSwipeIntroShown(): Promise<void> {
  const s = await read();
  await write({ ...s, count: s.count + 1, lastAt: Date.now() });
}

/** The user swiped sideways by hand. Both hints are finished, permanently. */
export async function noteLandscapeSwiped(): Promise<void> {
  const s = await read();
  if (s.swiped) return;
  await write({ ...s, swiped: true });
}
