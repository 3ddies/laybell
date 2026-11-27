'use client';
// Browser-side cart for the web shop. Holds only { listing_id, kind } (+ display copy):
// NO prices are trusted from here — shop_begin_stripe_cart re-prices every item server-side
// at checkout, exactly like buy-now. Persisted in localStorage, synced within a tab via a
// custom event and across tabs via `storage`. Everything is wrapped so private-mode / blocked
// storage degrades to an empty cart instead of throwing.
import { useEffect, useState } from 'react';

export type CartItem = {
  listing_id: string;
  kind: 'sell' | 'lease';
  title: string;
  price: string;        // display price, e.g. "$9.99"
  price_cents: number;  // for the displayed subtotal ONLY; the server re-prices at checkout
  cover_url: string | null;
  label?: string;       // "Buy" / "Lease"
};

const KEY = 'laybell_cart_v1';
const EVT = 'laybell-cart-changed';
const MAX = 20;

function read(): CartItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v)
      ? v.filter((i: any) => i && i.listing_id && (i.kind === 'sell' || i.kind === 'lease'))
      : [];
  } catch { return []; }
}
function write(items: CartItem[]) {
  try { localStorage.setItem(KEY, JSON.stringify(items)); } catch { /* private mode / blocked */ }
  try { window.dispatchEvent(new Event(EVT)); } catch { /* ignore */ }
}

export function getCart(): CartItem[] { return read(); }
export function cartHas(listingId: string, kind: string): boolean {
  return read().some((i) => i.listing_id === listingId && i.kind === kind);
}
export function addToCart(item: CartItem): boolean {
  const items = read();
  if (items.some((i) => i.listing_id === item.listing_id && i.kind === item.kind)) return false;
  if (items.length >= MAX) return false;
  write([...items, item]);
  return true;
}
export function removeFromCart(listingId: string, kind: string) {
  write(read().filter((i) => !(i.listing_id === listingId && i.kind === kind)));
}
export function clearCart() { write([]); }

// Remember exactly which items a cart checkout is paying for (keyed by the server cart id),
// so /purchases can clear ONLY those on delivery — not items added to the cart afterward.
const coKey = (cartId: string) => 'laybell_cart_co_' + cartId;
export function stashCheckout(cartId: string, keys: { listing_id: string; kind: string }[]) {
  try { localStorage.setItem(coKey(cartId), JSON.stringify(keys.map((k) => ({ listing_id: k.listing_id, kind: k.kind })))); } catch { /* ignore */ }
}
export function clearCheckout(cartId: string) {
  let keys: { listing_id: string; kind: string }[] = [];
  try { keys = JSON.parse(localStorage.getItem(coKey(cartId)) || '[]'); } catch { keys = []; }
  try { localStorage.removeItem(coKey(cartId)); } catch { /* ignore */ }
  if (Array.isArray(keys) && keys.length) {
    write(read().filter((i) => !keys.some((k) => k.listing_id === i.listing_id && k.kind === i.kind)));
  } else {
    write([]);  // no snapshot (e.g. storage cleared) → fall back to emptying the cart
  }
}

// Live cart for components. Starts empty on the server/first paint (no localStorage), then
// syncs on mount — callers must tolerate a 0 → N settle (a count badge, etc.).
export function useCart(): CartItem[] {
  const [items, setItems] = useState<CartItem[]>([]);
  useEffect(() => {
    const sync = () => setItems(read());
    sync();
    window.addEventListener(EVT, sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener(EVT, sync); window.removeEventListener('storage', sync); };
  }, []);
  return items;
}
