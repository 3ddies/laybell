import { offlinePinLimit, type Tier } from './badges';

// Single source of truth for the user's PREMIUM (paid) status. Set from
// PremiumContext (which reads RevenueCat) and readable SYNCHRONOUSLY anywhere —
// including module-level code like lib/ads.ts and the offline engine — without a
// React-context dependency, mirroring how lib/offline.ts exposes its state.
//
// Defaults false and stays false until a real purchase is active AND the native
// RevenueCat module is in the build, so every premium perk degrades to the free
// experience pre-rebuild / pre-setup.

let _premium = false;
const listeners = new Set<() => void>();

export function isPremium(): boolean { return _premium; }

export function setPremium(v: boolean): void {
  if (v === _premium) return;
  _premium = v;
  listeners.forEach((l) => { try { l(); } catch {} });
}

export function subscribePremium(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Premium removes the per-tier offline COUNT limit. The 3 GB device byte cap in
// lib/offline.ts still applies, so this is "unlimited, byte-capped" — never
// unbounded device storage. Non-premium gets the earned-tier allowance.
export const PREMIUM_PIN_LIMIT = 100_000;
export function effectivePinLimit(tier: Tier | null, premium = isPremium()): number {
  return premium ? PREMIUM_PIN_LIMIT : offlinePinLimit(tier);
}

// Ad-free is a premium perk. Read at the ad fetch/pick chokepoints in lib/ads.ts so
// feed, reel, and audio ads are all suppressed for subscribers from one place.
export function adFree(premium = isPremium()): boolean { return premium; }
