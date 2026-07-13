// Guarded, fire-and-forget wrapper around expo-haptics.
//
// expo-haptics is a NATIVE module. If a JS bundle that calls it ships over OTA
// before the dev client / build that bundles the native side, importing or
// calling it directly would throw. We lazy-require it once and swallow every
// error, so the haptic simply NO-OPS until the next native rebuild includes the
// module — then it starts working with no JS change (same pass-through spirit as
// compressVideoIfPossible in lib/upload.ts).

let mod: typeof import('expo-haptics') | null | undefined;

function load(): typeof import('expo-haptics') | null {
  if (mod !== undefined) return mod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('expo-haptics');
  } catch {
    mod = null;
  }
  return mod ?? null;
}

// The tab-swipe landing tick. A MEDIUM impact (iOS UIImpactFeedbackGenerator) —
// noticeably more powerful than the light "selection" detent, so the swipe-land
// feedback is felt clearly. Fire-and-forget: never awaited, never throws, no-ops
// where haptics aren't available (older devices, some Android, or before the
// native rebuild). To make it stronger/softer, swap Medium for Heavy/Rigid/Light.
export function tabTick(): void {
  try {
    const h = load();
    h?.impactAsync?.(h.ImpactFeedbackStyle?.Medium)?.catch(() => {});
  } catch {
    /* haptics unavailable — ignore */
  }
}

// A soft "pop" for landing a message reaction — LIGHT impact, distinct from the
// heavier tab tick. Same fire-and-forget contract: never awaited, never throws.
export function reactionPop(): void {
  try {
    const h = load();
    h?.impactAsync?.(h.ImpactFeedbackStyle?.Light)?.catch(() => {});
  } catch {
    /* haptics unavailable — ignore */
  }
}

// The light "selection" detent — the subtle tick iOS uses for small binary state
// flips (follow, like, save, opening a long-press menu). Softer and drier than an
// impact. Fire-and-forget: never awaited, never throws, no-ops where haptics
// aren't available.
export function selection(): void {
  try {
    const h = load();
    h?.selectionAsync?.()?.catch(() => {});
  } catch {
    /* haptics unavailable — ignore */
  }
}

// A LIGHT impact tap — a soft confirming knock for a committed action (send a
// message, a swipe-up pull-to-refresh). Same fire-and-forget contract as above.
export function impactLight(): void {
  try {
    const h = load();
    h?.impactAsync?.(h.ImpactFeedbackStyle?.Light)?.catch(() => {});
  } catch {
    /* haptics unavailable — ignore */
  }
}

// iOS notification feedbacks — the distinctive success / warning "double taps".
// Success: a completed action (a post published). Warning: a destructive prompt
// appearing (delete / block / remove). Same fire-and-forget contract as above.
export function notifySuccess(): void {
  try {
    const h = load();
    h?.notificationAsync?.(h.NotificationFeedbackType?.Success)?.catch(() => {});
  } catch {
    /* haptics unavailable — ignore */
  }
}

export function notifyWarning(): void {
  try {
    const h = load();
    h?.notificationAsync?.(h.NotificationFeedbackType?.Warning)?.catch(() => {});
  } catch {
    /* haptics unavailable — ignore */
  }
}
