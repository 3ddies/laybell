import { offlinePinLimit, setBadgePremiumGetter, type Tier } from './badges';

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

// Ad-free is a premium perk for the HOME FEED only. Read at fetchFeedAds in
// lib/ads.ts so feed ads are suppressed for subscribers. Reels and Music are NOT
// ad-free for premium — they get HALF the ads instead (see adSpacingMultiplier).
export function adFree(premium = isPremium()): boolean { return premium; }

// Reels + Music (audio) get ~50% FEWER ads for premium — not zero. Ad cadence is
// spacing-based (reels: gap between ads; audio: ms between breaks), so doubling
// the spacing halves the ad count. Free users get the normal cadence (×1). Read
// inside lib/ads.ts (weaveReelAds / nextAudioGateMs / firstAudioGateMs).
export const PREMIUM_AD_SPACING_MULT = 2;
export function adSpacingMultiplier(premium = isPremium()): number {
  return premium ? PREMIUM_AD_SPACING_MULT : 1;
}

// Time-sensitive badges (login/like streaks, daily music/comment badges) get a
// longer grace window for premium — a busy day (up to 3) never breaks a streak.
// Free users keep the default midnight grace (see lib/badges GRACE_HOURS).
export const PREMIUM_BADGE_GRACE_DAYS = 3;

// Push the premium getter into the badge engine so it can widen the grace window
// without importing this module (badges.ts is imported HERE — the reverse import
// would be a cycle). Read at badge-evaluation time, so it always sees live status.
setBadgePremiumGetter(isPremium);
