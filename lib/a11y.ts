import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

// Accessibility preferences.
//
// Reduce Motion is the one accessibility setting whose absence actively HARMS
// people rather than merely excluding them: for users with vestibular disorders,
// large sliding, scaling and bursting animations cause real nausea and dizziness.
// Laybell is unusually motion-heavy — a full-screen pager, a heart burst on
// double-tap, position-driven tab-bar animation, sheet transitions — so honouring
// the OS setting matters more here than in a typical app.
//
// The setting is a system-level toggle (iOS: Settings → Accessibility → Motion →
// Reduce Motion; Android: Settings → Accessibility → Remove animations). Users who
// need it have already turned it on; the app just has to ask.

let cached: boolean | null = null;
const listeners = new Set<(v: boolean) => void>();
let subscribed = false;

function publish(v: boolean) {
  cached = v;
  listeners.forEach((fn) => fn(v));
}

function ensureSubscription() {
  if (subscribed) return;
  subscribed = true;
  AccessibilityInfo.isReduceMotionEnabled()
    .then((v) => publish(!!v))
    .catch(() => publish(false));
  // The user can change this while the app is running — a settings trip mid-session
  // is exactly what someone does when the motion starts bothering them.
  try {
    AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => publish(!!v));
  } catch { /* older RN / unsupported platform */ }
}

/**
 * True when the user has asked the system to reduce motion.
 *
 * Shared subscription rather than one listener per component: this is read on hot
 * paths (every feed cell that can animate), and hundreds of independent
 * AccessibilityInfo listeners would be wasteful.
 */
export function useReduceMotion(): boolean {
  ensureSubscription();
  const [value, setValue] = useState<boolean>(cached ?? false);
  useEffect(() => {
    listeners.add(setValue);
    if (cached !== null) setValue(cached);
    return () => { listeners.delete(setValue); };
  }, []);
  return value;
}

/** Non-hook read, for imperative animation code outside a component. */
export function reduceMotionEnabled(): boolean {
  ensureSubscription();
  return cached ?? false;
}

/**
 * Duration helper: collapses an animation to near-instant when Reduce Motion is
 * on. Not zero — a 1ms animation still runs its completion callback, whereas
 * skipping the animation entirely tends to strand state that the callback was
 * supposed to settle.
 */
export function motionDuration(ms: number, reduced = reduceMotionEnabled()): number {
  return reduced ? 1 : ms;
}
