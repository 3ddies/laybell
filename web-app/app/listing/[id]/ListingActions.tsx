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

export default function ListingActions({ listingId, deals, appLink, note, title, cover, priceCents }: {
  listingId: string; deals: DealRow[]; appLink: string; note: string;
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

  function add(d: DealRow) {
    addToCart({
      listing_id: listingId, kind: d.kind as 'sell' | 'lease', title,
      price: d.price, price_cents: priceCents[d.kind as 'sell' | 'lease'] ?? 0,
      cover_url: cover, label: d.label,
    });
  }

  const paid = deals.filter((d) => d.kind !== 'free');
  const free = deals.find((d) => d.kind === 'free');

  return (
    <div className="ldeals">
      {deals.map((d) => (
        <div className={`ldeal ${d.kind}`} key={d.kind}>
          <div className="ld-main"><b>{d.label}</b><span>{d.sub}</span></div>
          <div className="ld-price">{d.price}</div>
        </div>
      ))}

      {err ? <div className="authmsg err">{err}</div> : null}

      {paid.map((d) => (
        <div className="lbuyrow" key={d.kind}>
          {authed === false ? (
            <a className="btn btn-primary lbuy" href={`/login?next=${encodeURIComponent(`/listing/${listingId}`)}`}>{d.label} · {d.price}</a>
          ) : (
            <button className="btn btn-primary lbuy" disabled={!!busy || authed === null} onClick={() => buy(d.kind as 'sell' | 'lease')}>
              {busy === d.kind ? 'Starting secure checkout…' : `${d.label} with card · ${d.price}`}
            </button>
          )}
          <button className="btn btn-ghost lcart" disabled={!!inCart[d.kind]} onClick={() => add(d)}>
            {inCart[d.kind] ? 'In cart ✓' : 'Add to cart'}
          </button>
        </div>
      ))}

      {free ? (
        <a className="btn btn-ghost lbuy" href={appLink}>Get the free download in the app</a>
      ) : null}

      <p className="lnote">{paid.length ? 'Secure checkout with card, powered by Stripe. ' : ''}{note}</p>
      {paid.length ? <a className="lapp" href={appLink}>Prefer the app? Buy there instead →</a> : null}
    </div>
  );
}
