import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Reusable coachmark / walkthrough system ──────────────────────────────────
// One home for every in-app tip: a one-time flag keyed per coachmark, a hook that
// tells a screen whether to show its tip, a target-measuring hook so pointer arrows
// land on the real element (never a guessed margin), and a reset for the "Replay
// tutorials" setting. Keys live in COACHMARKS so they're documented, collision-free,
// and resettable together. Bump VERSION to re-show every coachmark after a revamp.

const VERSION = 'v1';
const PREFIX = `coach:${VERSION}:`;

// Older, pre-system one-time keys (hand-rolled before this lib existed). Listed so
// "Replay tutorials" clears them too, and so we remember to migrate them later.
const LEGACY_KEYS = ['dj:recWalkthroughSeen', 'dj:perkPointerSeen'];

// Every coachmark in the app. Add a key here, never a bare string at the call site.
export const COACHMARKS = {
  shopBuy: 'shop.buy',
  walletEarn: 'wallet.earn',
  spotlightPromote: 'spotlight.promote',
  premiumPerks: 'premium.perks',
} as const;
export type CoachmarkKey = (typeof COACHMARKS)[keyof typeof COACHMARKS];

// Within a session, remember what's been seen/dismissed so a re-mount or re-focus
// doesn't flash the tip again before AsyncStorage resolves.
const seen = new Set<string>();

/**
 * Whether this coachmark should show, plus markSeen() to dismiss it for good.
 * Pass `ready=false` to defer until the screen's data/layout is in (so the tip
 * doesn't point at something that hasn't rendered yet).
 */
export function useCoachmark(key: string, ready: boolean = true) {
  const [shouldShow, setShouldShow] = useState(false);
  useEffect(() => {
    if (!ready || seen.has(key)) return;
    let alive = true;
    AsyncStorage.getItem(PREFIX + key)
      .then((v) => {
        if (!alive) return;
        if (v) { seen.add(key); return; }
        setShouldShow(true);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [key, ready]);

  const markSeen = useCallback(() => {
    seen.add(key);
    setShouldShow(false);
    AsyncStorage.setItem(PREFIX + key, '1').catch(() => {});
  }, [key]);

  return { shouldShow, markSeen };
}

export type CoachTargetRect = { x: number; y: number; w: number; h: number };
export type CoachTarget = {
  ref: RefObject<any>;
  onLayout: () => void;
  measure: () => void;
  rect: CoachTargetRect | null;
};

/**
 * Attach to the element a pointer-style coachmark should aim at:
 *   const target = useCoachmarkTarget();
 *   <Btn ref={target.ref} onLayout={target.onLayout} />
 * The arrow is then placed at the element's MEASURED window position. Call measure()
 * again if the element moves (e.g. after a layout change) and you need to re-aim.
 */
export function useCoachmarkTarget(): CoachTarget {
  const ref = useRef<any>(null);
  const [rect, setRect] = useState<CoachTargetRect | null>(null);
  const measure = useCallback(() => {
    ref.current?.measureInWindow?.((x: number, y: number, w: number, h: number) => {
      if (w > 0 || h > 0) setRect({ x, y, w, h });
    });
  }, []);
  return { ref, onLayout: measure, measure, rect };
}

/**
 * "Replay tutorials": clear every coachmark flag — this version, any older version,
 * and the pre-system keys — so all tips show again on the next visit.
 */
export async function resetAllCoachmarks(): Promise<void> {
  seen.clear();
  try {
    const keys = await AsyncStorage.getAllKeys();
    const mine = keys.filter((k) => k.startsWith('coach:') || LEGACY_KEYS.includes(k));
    if (mine.length) await AsyncStorage.multiRemove(mine);
  } catch {}
}
