'use client';
import Link from 'next/link';
import { useCart } from '@/lib/cart';

// The cart entry in the topbar, with a live item-count badge. Always visible (guests can
// build a cart, then log in at checkout).
export default function CartLink() {
  const items = useCart();
  const n = items.length;
  return (
    <Link className="navlink cartlink" href="/cart" aria-label={n ? `Cart, ${n} item${n > 1 ? 's' : ''}` : 'Cart'}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="9" cy="20" r="1.4" /><circle cx="18" cy="20" r="1.4" />
        <path d="M2.5 3h2.2l2.2 12a1.6 1.6 0 0 0 1.6 1.3h8.1a1.6 1.6 0 0 0 1.6-1.3L21 7H6.2" />
      </svg>
      <span>Cart</span>
      {n > 0 ? <span className="cartbadge">{n}</span> : null}
    </Link>
  );
}
