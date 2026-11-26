'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { browserSb } from '@/lib/supabaseBrowser';
import { useCart, removeFromCart, getCart } from '@/lib/cart';
import { gradientFor } from '@/lib/format';

function prettyErr(m?: string): string {
  const map: Record<string, string> = {
    not_signed_in: 'Please log in to check out.',
    cart_empty: 'Your cart is empty.',
    cart_too_large: 'Your cart has too many items (20 max).',
    already_purchased: 'You already own one of these — remove it to continue.',
    listing_not_available: 'One of these is no longer available — remove it to continue.',
    cannot_buy_own: 'Your cart has one of your own items — remove it to continue.',
    cart_below_min: 'The total is below the card-payment minimum.',
    cannot_checkout: 'Couldn’t start checkout. Please try again.',
    stripe_not_configured: 'Card payments aren’t available right now.',
  };
  if (!m) return 'Something went wrong. Please try again.';
  for (const k in map) if (m.includes(k)) return map[k];
  return 'Couldn’t start checkout. Please try again.';
}

function CartInner() {
  const sb = browserSb();
  const items = useCart();
  const canceled = useSearchParams().get('canceled');
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    sb.auth.getSession().then(({ data }) => setAuthed(!!data.session));
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setAuthed(!!s));
    return () => sub.subscription.unsubscribe();
  }, [sb]);

  const totalCents = items.reduce((s, i) => s + (Number(i.price_cents) || 0), 0);
  const total = `$${(totalCents / 100).toFixed(2)}`;

  async function checkout() {
    setErr(null); setBusy(true);
    try {
      const payload = getCart().map((i) => ({ listing_id: i.listing_id, kind: i.kind }));
      const { data, error } = await sb.functions.invoke('shop-cart-checkout', { body: { items: payload } });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      if (!(data as any)?.url) throw new Error('cannot_checkout');
      window.location.href = (data as any).url as string;
    } catch (e: any) {
      setErr(prettyErr(e?.message));
      setBusy(false);
    }
  }

  if (items.length === 0) {
    return (
      <main className="purchases">
        <h1>Your cart</h1>
        {canceled ? <div className="pbanner refund">Checkout canceled — your cart is still here.</div> : null}
        <div className="state"><h2 style={{ fontSize: 18 }}>Your cart is empty</h2><p>Add beats from the <Link href="/market">shop</Link> and they’ll show up here.</p></div>
      </main>
    );
  }

  return (
    <main className="purchases">
      <h1>Your cart</h1>
      {canceled ? <div className="pbanner refund">Checkout canceled — your cart is still here.</div> : null}
      {err ? <div className="pbanner err">{err}</div> : null}
      <div className="plist">
        {items.map((i) => (
          <div className="prow" key={`${i.listing_id}:${i.kind}`}>
            <Link href={`/listing/${i.listing_id}`} className="part" style={!i.cover_url ? { background: gradientFor(i.listing_id) } : undefined}>
              {i.cover_url ? <img src={i.cover_url} alt="" /> : null}
            </Link>
            <div className="pinfo2">
              <b>{i.title}</b>
              <span>{i.label || (i.kind === 'lease' ? 'Lease' : 'Buy')} · {i.price}</span>
            </div>
            <button className="btn btn-ghost pdl" onClick={() => removeFromCart(i.listing_id, i.kind)}>Remove</button>
          </div>
        ))}
      </div>
      <div className="carttotal"><span>Total</span><b>{total}</b></div>
      <p className="lnote">Tax, if any, is calculated at checkout. Secure checkout powered by Stripe.</p>
      {authed === false ? (
        <a className="btn btn-primary lbuy" href="/login?next=/cart">Log in to check out</a>
      ) : (
        <button className="btn btn-primary lbuy" disabled={busy || authed === null} onClick={checkout}>
          {busy ? 'Starting secure checkout…' : `Check out · ${total}`}
        </button>
      )}
    </main>
  );
}

export default function CartPage() {
  return (
    <Suspense fallback={<main className="purchases"><div className="feed-empty">Loading…</div></main>}>
      <CartInner />
    </Suspense>
  );
}
