// Read-only shop model for the web. The pure display helpers here are ported
// from the mobile app's lib/shop.ts — keep them in sync. There is deliberately
// NO money logic and NO network code: the web only ever READS public listing
// columns with the anon key, and Supabase RLS does the visibility filtering
// (active status + non-hidden seller + non-copyright-removed + non-taken-down).
// Buying always happens in the app.

export type ListingCategory = 'beat' | 'song' | 'sample_pack' | 'preset' | 'service' | 'other';
export type ListingLicense = 'exclusive' | 'nonexclusive' | 'free';
export type ListingStatus = 'active' | 'paused' | 'sold' | 'removed';

export type WebListing = {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  category: ListingCategory;
  genre: string | null;
  currency: string;
  license: ListingLicense;
  price_cents: number;
  sell_enabled?: boolean | null;
  sell_price_cents?: number | null;
  lease_enabled?: boolean | null;
  lease_price_cents?: number | null;
  free_enabled?: boolean | null;
  free_requires_follow?: boolean | null;
  status: ListingStatus;
  sales_count?: number | null;
  lease_count?: number | null;
  free_count?: number | null;
  cover_url: string | null;
  preview_url: string | null;
  created_at: string;
};

// Public columns ONLY. Server components serialize whatever they select into the
// client payload, so this list must NEVER include `file_path` (the private
// deliverable) or `free_like_post_ids`. Those stay server-side / in the app.
export const LISTING_PUBLIC_COLS =
  'id,user_id,title,description,category,genre,currency,license,price_cents,sell_enabled,sell_price_cents,lease_enabled,lease_price_cents,free_enabled,free_requires_follow,status,sales_count,lease_count,free_count,cover_url,preview_url,created_at';

export const CATEGORY_LABEL: Record<ListingCategory, string> = {
  beat: 'Beat', song: 'Song', sample_pack: 'Sample pack', preset: 'Preset', service: 'Service', other: 'Digital good',
};

// ── Price helpers (mirror lib/shop.ts in the app) ─────────────────────────────
export function formatAmount(cents: number, currency = 'USD'): string {
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  const dollars = Math.max(0, cents) / 100;
  return `${symbol}${Number.isInteger(dollars) ? dollars : dollars.toFixed(2)}`;
}
export function formatPrice(cents: number, currency = 'USD'): string {
  if (cents <= 0) return 'Free';
  return formatAmount(cents, currency);
}

export type SaleTypes = { sell: boolean; lease: boolean; free: boolean };

/** The deal types a listing offers. Multi-type flags win; legacy rows (no flags)
    fall back to the single `license` axis. */
export function saleTypes(l: WebListing): SaleTypes {
  if (l.sell_enabled || l.lease_enabled || l.free_enabled) {
    return { sell: !!l.sell_enabled, lease: !!l.lease_enabled, free: !!l.free_enabled };
  }
  return { sell: l.license === 'exclusive', lease: l.license === 'nonexclusive', free: l.license === 'free' };
}

export function priceForKind(l: WebListing, kind: 'sell' | 'lease' | 'free'): number {
  if (kind === 'free') return 0;
  if (kind === 'sell') return l.sell_enabled ? (l.sell_price_cents ?? 0) : l.price_cents;
  return l.lease_enabled ? (l.lease_price_cents ?? 0) : l.price_cents;
}

/** Card tag: cheapest paid price ("+" when there's more than one way to get it),
    or "Free" for free-only listings. */
export function listingPriceLabel(l: WebListing): string {
  const t = saleTypes(l);
  const paid: number[] = [];
  if (t.sell) paid.push(priceForKind(l, 'sell'));
  if (t.lease) paid.push(priceForKind(l, 'lease'));
  const ways = paid.length + (t.free ? 1 : 0);
  if (!paid.length) return 'Free';
  const min = Math.min(...paid);
  const base = min <= 0 ? 'Free' : formatPrice(min, l.currency);
  return ways > 1 ? `${base}+` : base;
}

export type DealRow = { kind: 'sell' | 'lease' | 'free'; label: string; sub: string; price: string };

/** The purchase options to list on the detail page (buying happens in the app). */
export function dealRows(l: WebListing): DealRow[] {
  const t = saleTypes(l);
  const rows: DealRow[] = [];
  if (t.sell) rows.push({ kind: 'sell', label: 'Buy', sub: 'Exclusive — full rights', price: formatPrice(priceForKind(l, 'sell'), l.currency) });
  if (t.lease) rows.push({ kind: 'lease', label: 'Lease', sub: 'Non-exclusive license', price: formatPrice(priceForKind(l, 'lease'), l.currency) });
  if (t.free) rows.push({ kind: 'free', label: 'Free', sub: l.free_requires_follow ? 'Follow to unlock' : 'Free download', price: 'Free' });
  return rows;
}

/** The app deep-link that opens this listing to buy. */
export function listingAppLink(id: string): string {
  return `https://laybell.app/open.html?p=shop/listing/${id}`;
}
