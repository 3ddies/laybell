// Beat price-tier ladder for DIRECT in-app purchases (IAP).
//
// Apple/Google IAP only sells FIXED price points, so a beat sold via the one-tap
// "Buy $X.99" path must be priced at one of these tiers. A price OFF the ladder
// (or above the top tier) falls back to credits-only — no IAP button.
//
// ⚠️ This list MUST stay in sync with THREE other places or a purchase can charge
// and never deliver:
//   1. the IAP products created in App Store Connect AND Google Play
//      (one consumable per tier, id `laybell_item_<cents>`),
//   2. the ITEM_PRODUCTS map in supabase/functions/revenuecat-webhook/index.ts,
//   3. shop_price_tiers() in supabase/sql/shop_iap.sql.
// One list, three mirrors, never drifting. See docs/BEATS_IAP_PLAN.md.

export const PRICE_TIERS_CENTS = [
  499, 999, 1499, 1999, 2499, 2999, 3499, 3999, 4999, 5999, 6999, 7999,
  9999, 12999, 14999, 19999, 24999, 29999, 39999, 49999, 69999, 99999,
] as const;

export const MIN_TIER_CENTS = PRICE_TIERS_CENTS[0];                              // $4.99
export const MAX_TIER_CENTS = PRICE_TIERS_CENTS[PRICE_TIERS_CENTS.length - 1];   // $999.99

const TIER_SET: ReadonlySet<number> = new Set<number>(PRICE_TIERS_CENTS);

/** True when a price is exactly one of the allowed IAP tiers. */
export function isPriceTier(cents: number): boolean {
  return TIER_SET.has(cents);
}

/** The consumable IAP product id for a tier, e.g. 499 → 'laybell_item_499'. */
export function itemProductId(cents: number): string {
  return `laybell_item_${cents}`;
}

/** Every item product id, cheapest first. */
export const ITEM_PRODUCT_IDS: readonly string[] = PRICE_TIERS_CENTS.map(itemProductId);

/** Whether a listing price can be bought via direct IAP (is on the ladder). */
export function canBuyWithIap(cents: number | null | undefined): boolean {
  return typeof cents === 'number' && isPriceTier(cents);
}

/** Nearest tier to an arbitrary price; null for a non-positive price. Ties resolve
 *  to the lower tier (never silently rounds a seller UP into a higher bracket). */
export function nearestTier(cents: number): number | null {
  if (!Number.isFinite(cents) || cents <= 0) return null;
  let best: number = PRICE_TIERS_CENTS[0];
  let bestD = Math.abs(cents - best);
  for (const t of PRICE_TIERS_CENTS) {
    const d = Math.abs(cents - t);
    if (d < bestD) { best = t; bestD = d; }   // strict < → ties keep the lower tier
  }
  return best;
}

/** "$4.99" from 499. */
export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
