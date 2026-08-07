import { offlinePinLimit, setBadgePremiumGetter, setBadgeFreezeGetter, type Tier } from './badges';
import { reportError } from './monitoring';

// Single source of truth for the user's PREMIUM (paid) status. Set from
// PremiumContext (which reads RevenueCat) and readable SYNCHRONOUSLY anywhere —
// including module-level code like lib/ads.ts and the offline engine — without a
// React-context dependency, mirroring how lib/offline.ts exposes its state.
//
// Defaults false and stays false until a real purchase is active AND the native
// RevenueCat module is in the build, so every premium perk degrades to the free
// experience pre-rebuild / pre-setup.

let _premium = false;
let _premiumPlus = false;
const listeners = new Set<() => void>();

function notify(context: Record<string, unknown>): void {
  // One broken listener must not stop the others from learning that Premium
  // changed — but a listener that throws here is a piece of UI that silently
  // failed to reflect a paid entitlement, which is worth knowing about.
  listeners.forEach((l) => { try { l(); } catch (e) { reportError(e, { stage: 'entitlements.notify', ...context }); } });
}

// SECOND SOURCE: the profiles-row mirror (premium_until / premium_plus_until),
// written only by the RevenueCat webhook / service role — the protect trigger
// blocks self-grant. It ORs into the reads rather than replacing the SDK flags:
// the RC SDK can be configured (keys present) while an entitlement doesn't
// exist in its dashboard yet, and the mirror must still win. Both sources are
// RC-derived truth — one via the device SDK, one via the server webhook — and
// the mirror self-expires by timestamp, so a lapsed sub reads false either way.
let _premiumMirror = false;
let _premiumPlusMirror = false;
export function setEntitlementMirror(premium: boolean, plus: boolean): void {
  if (premium === _premiumMirror && plus === _premiumPlusMirror) return;
  _premiumMirror = premium;
  _premiumPlusMirror = plus;
  notify({ premiumMirror: premium, premiumPlusMirror: plus });
}

// Premium+ is a SUPERSET: an active plus subscription counts as premium
// everywhere the $9.99 perks are read, with no call-site changes.
export function isPremium(): boolean { return _premium || _premiumMirror || isPremiumPlus(); }

// The $19.99 tier on its own — Films posting + badge freeze read THIS.
export function isPremiumPlus(): boolean { return _premiumPlus || _premiumPlusMirror; }

export function setPremium(v: boolean): void {
  if (v === _premium) return;
  _premium = v;
  notify({ premium: v });
}

export function setPremiumPlus(v: boolean): void {
  if (v === _premiumPlus) return;
  _premiumPlus = v;
  notify({ premiumPlus: v });
}

// When the plus subscription ends/ended (ms epoch; null = never had one). Fed by
// both entitlement sources — RevenueCat customer info and the profiles-row
// fallback — solely so the badge freeze can honor its 24-hour post-cancel grace.
let _premiumPlusUntilMs: number | null = null;
export function setPremiumPlusUntil(ms: number | null): void { _premiumPlusUntilMs = ms; }

// The badge freeze holds while the subscription is active, and for 24 more hours
// after it lapses — the owner-specified window to pick streaks back up before
// the account is treated like a regular (or plain-premium) one again.
export const PLUS_LAPSE_GRACE_MS = 24 * 3600_000;
export function badgeFreezeActive(): boolean {
  if (isPremiumPlus()) return true; // either source — SDK or the DB mirror
  return _premiumPlusUntilMs != null && Date.now() < _premiumPlusUntilMs + PLUS_LAPSE_GRACE_MS;
}

// True only for someone who HAD Premium+ and let it lapse — the film-removal
// warning keys off this, so users who never subscribed are never queried
// (let alone warned) about films they cannot have.
export function premiumPlusLapsed(): boolean {
  return !_premiumPlus && _premiumPlusUntilMs != null && Date.now() >= _premiumPlusUntilMs;
}

// One listener set covers both tiers: subscribers re-read whichever flags they
// care about, so a plus change wakes premium consumers too (superset).
export function subscribePremium(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// ── Films (Premium+ perk) ────────────────────────────────────────────────────
// A film is any landscape video past the free 9-minute window. The boundary
// must match post.tsx's VIDEO_MAX_SEC_H and the server's enforce_film_rights
// trigger (premium_plus.sql) — all three say 540.
export const FILM_MIN_SEC = 540;
// The Premium+ landscape ceiling: 3 hours. The stream-tus-upload Edge Function
// clamps to this too, so a modified client cannot mint a longer upload.
// 1 hour (owner's call 2026-08-07, down from 3). Keeps every film inside the
// 5 Mbps 1080p budget — at this length the quality ladder never has to step
// down to 720p, so "a film" always means the best picture Laybell produces.
export const FILM_MAX_SEC = 1 * 3600;

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
setBadgeFreezeGetter(badgeFreezeActive);
