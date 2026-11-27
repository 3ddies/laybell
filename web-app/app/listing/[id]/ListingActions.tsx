'use client';
import { useEffect, useState } from 'react';
import { browserSb } from '@/lib/supabaseBrowser';
import type { DealRow } from '@/lib/shop';
import { addToCart, cartHas } from '@/lib/cart';

function prettyErr(m?: string): string {
  const map: Record<string, string> = {
    not_signed_in: 'Please log in to buy.',
    listing_not_found: 'This item no longer exists.',
    listing_not_available: 'This item is no longer for sale.',
    cannot_buy_own: 'You can’t buy your own item.',
    already_purchased: 'You already own this.',
    kind_not_available: 'That option isn’t available for this item.',
    price_unset: 'This item has no price set.',
    price_below_min: 'This item’s price is below the card-payment minimum.',
    bad_price: 'This item’s price can’t be charged.',
    cannot_checkout: 'Couldn’t start checkout. Please try again.',
    stripe_not_configured: 'Card payments aren’t available right now.',
  };
  if (!m) return 'Something went wrong. Please try again.';
  for (const k in map) if (m.includes(k)) return map[k];
  return 'Couldn’t start checkout. Please try again.';
}

export default function ListingActions({ listingId, deals, appLink, title, cover, priceCents }: {
  listingId: string; deals: DealRow[]; appLink: string;
  title: string; cover: string | null; priceCents: Partial<Record<'sell' | 'lease', number>>;
}) {
  const sb = browserSb();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [inCart, setInCart] = useState<Record<string, boolean>>({});

  useEffect(() => {
    sb.auth.getSession().then(({ data }) => setAuthed(!!data.session));
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setAuthed(!!s));
    return () => sub.subscription.unsubscribe();
  }, [sb]);

  // Reflect current cart membership (updates on add/remove here or in another tab).
  useEffect(() => {
    const sync = () => setInCart({ sell: cartHas(listingId, 'sell'), lease: cartHas(listingId, 'lease') });
    sync();
    window.addEventListener('laybell-cart-changed', sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener('laybell-cart-changed', sync); window.removeEventListener('storage', sync); };
  }, [listingId]);

  async function buy(kind: 'sell' | 'lease') {
    setErr(null); setBusy(kind);
    try {
      const { data, error } = await sb.functions.invoke('stripe-checkout', { body: { listing_id: listingId, kind } });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      if (!(data as any)?.url) throw new Error('cannot_checkout');
      window.location.href = (data as any).url as string;
    } catch (e: any) {
      setErr(prettyErr(e?.message));
      setBusy(null);
    }
  }

  // Guest (not signed in) checkout — no account needed; the download is emailed + shown on
  // the success page. Hits the public shop-guest-checkout edge fn.
  async function guestBuy(kind: 'sell' | 'lease') {
    setErr(null); setBusy(kind);
    try {
      const { data, error } = await sb.functions.invoke('shop-guest-checkout', { body: { listing_id: listingId, kind } });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      if (!(data as any)?.url) throw new Error('cannot_checkout');
      window.location.href = (data as any).url as string;
    } catch (e: any) {
      setErr(prettyErr(e?.message));
      setBusy(null);
    }
  }

  function add(d: DealRow) {
    addToCart({
      listing_id: listingId, kind: d.kind as 'sell' | 'lease', title,
      price: d.price, price_cents: priceCents[d.kind as 'sell' | 'lease'] ?? 0,
      cover_url: cover, label: d.label,
    });
  }

  const paid = deals.filter((d) => d.kind !== 'free');

  return (
    <div className="ldeals">
      {err ? <div className="authmsg err">{err}</div> : null}

      {deals.map((d) => {
        const kind = d.kind as 'sell' | 'lease' | 'free';

        // Free = an app-only claim: the whole card links into the app.
        if (kind === 'free') {
          return (
            <a className={`ldeal ${kind} ldeal-free`} key={d.kind} href={appLink}>
              <span className="ld-hit">
                <span className="ld-main"><b>{d.label}</b><span>{d.sub}</span></span>
                <span className="ld-pricewrap">
                  <span className="ld-price">{d.price}</span>
                  <span className="ld-cta">Get in the app ›</span>
                </span>
              </span>
            </a>
          );
        }

        // Paid = tap the whole card to check out with card. The small cart button is
        // a sibling (never nested — a <button> can't contain a <button>).
        const isBusy = busy === kind;
        return (
          <div className={`ldeal ${kind} ldeal-buy`} key={d.kind}>
            <button
              className="ld-hit"
              disabled={!!busy || authed === null}
              onClick={() => (authed ? buy(kind) : guestBuy(kind))}
              aria-label={`${d.label} ${d.price} — check out with card`}
            >
              <span className="ld-main"><b>{d.label}</b><span>{d.sub}</span></span>
              <span className="ld-pricewrap">
                <span className="ld-price">{d.price}</span>
                <span className="ld-cta">
                  {isBusy ? <><span className="cspin" /> Starting…</> : `${d.label} Now ›`}
                </span>
              </span>
            </button>
            <button
              className="ld-cart"
              disabled={!!inCart[kind]}
              onClick={() => add(d)}
              aria-label={inCart[kind] ? 'In cart' : 'Add to cart'}
              title={inCart[kind] ? 'In cart' : 'Add to cart'}
            >
              {inCart[kind] ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="20" r="1.4" /><circle cx="18" cy="20" r="1.4" /><path d="M2.5 3h2.2l2.2 11.2a1.6 1.6 0 0 0 1.6 1.3h8.1a1.6 1.6 0 0 0 1.6-1.3L21 7H6" /></svg>
              )}
            </button>
          </div>
        );
      })}

      <p className="lnote">
        {paid.length ? 'Secure card payment via Stripe. ' : ''}
        {paid.length && authed === false ? 'No account needed. Your download is emailed and shown instantly.' : ''}
      </p>
      {paid.length ? <a className="lapp" href={appLink}>Prefer the app? Buy there instead →</a> : null}
    </div>
  );
}
