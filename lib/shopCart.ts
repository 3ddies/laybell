import { useCallback, useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { legacyKindOf, priceForKind, saleTypes, type SaleKind, type ShopListing } from './shop';

// Shop cart — a LOCAL, device-only collection of listings the buyer wants to
// request together. It's AsyncStorage-backed (no DB, OTA-safe), mirroring the
// drafts pattern: since the marketplace has no payment rails, the cart isn't an
// order — it's a shortlist, and "checkout" fires the same buy-REQUEST flow the
// listing page does, once per item (each DMs its seller). Nothing is charged.
//
// A tiny module store (subscribe + getSnapshot) drives a live cart-count badge
// anywhere via useShopCart(), without threading a provider through the tree.

const KEY = 'shop_cart_v1';

export type CartItem = {
  listingId: string;
  title: string;
  priceCents: number;
  currency: string;
  coverUrl: string | null;
  sellerId: string;
  sellerName: string;
  addedAt: number;
  // Which deal type the buyer wants (multi-type listings). Absent on items
  // added before the upgrade — checkout falls back to the legacy kind.
  kind?: SaleKind;
};

// `items` identity changes only on mutation, so useSyncExternalStore caches it
// correctly (no render loops).
let items: CartItem[] = [];
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function persist() {
  AsyncStorage.setItem(KEY, JSON.stringify(items)).catch(() => {});
}

// Hydrate once at module load. Until it resolves, the cart reads empty — a fresh
// launch shows 0 for a frame, then the stored items pop in.
AsyncStorage.getItem(KEY)
  .then((raw) => {
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) items = parsed;
      } catch { /* corrupt → empty cart */ }
    }
    hydrated = true;
    emit();
  })
  .catch(() => { hydrated = true; });

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function getSnapshot(): CartItem[] {
  return items;
}

export function isInCart(listingId: string): boolean {
  return items.some((i) => i.listingId === listingId);
}

/** The deal type the cart shortlists by default: a lease when offered (the
    everyday purchase), else the buy-out, else the freebie. */
export function defaultCartKind(listing: ShopListing): Exclude<SaleKind, 'offer'> {
  const types = saleTypes(listing);
  if (types.lease) return 'lease';
  if (types.sell) return 'sell';
  if (types.free) return 'free';
  return legacyKindOf(listing) as Exclude<SaleKind, 'offer'>;
}

/** Add a listing (no-op if already present). Returns the new count. */
export function addToCart(listing: ShopListing, kind?: Exclude<SaleKind, 'offer'>): number {
  if (isInCart(listing.id)) return items.length;
  const k = kind ?? defaultCartKind(listing);
  const item: CartItem = {
    listingId: listing.id,
    title: listing.title,
    priceCents: priceForKind(listing, k),
    currency: listing.currency,
    coverUrl: listing.cover_url ?? null,
    sellerId: listing.user_id,
    sellerName: listing.seller?.display_name || listing.seller?.username || '',
    addedAt: Date.now(),
    kind: k,
  };
  items = [item, ...items];
  persist();
  emit();
  return items.length;
}

export function removeFromCart(listingId: string): void {
  if (!isInCart(listingId)) return;
  items = items.filter((i) => i.listingId !== listingId);
  persist();
  emit();
}

export function clearCart(): void {
  if (items.length === 0) return;
  items = [];
  persist();
  emit();
}

export function cartSubtotalCents(list: CartItem[] = items): number {
  return list.reduce((sum, i) => sum + Math.max(0, i.priceCents), 0);
}

/** Live cart contents + count. Re-renders subscribers on every mutation. */
export function useShopCart(): { items: CartItem[]; count: number; hydrated: boolean } {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { items: snap, count: snap.length, hydrated };
}

/** Live in-cart flag for one listing (drives the Add/Remove toggle). */
export function useInCart(listingId: string | undefined): boolean {
  const getFlag = useCallback(() => (listingId ? isInCart(listingId) : false), [listingId]);
  return useSyncExternalStore(subscribe, getFlag, getFlag);
}
