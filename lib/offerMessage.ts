// Buy-offers as a special DM. Encoded INSIDE the message body, the same trick
// attachments, shared posts and story replies use, so no schema change is needed:
//
//   laybell://offer?order=<id>&listing=<id>&cents=<n>&cur=<USD>&title=<encoded>
//   <optional note on the next line(s)>
//
// WHY THE ORDER ID IS THE PAYLOAD, and the price is only along for the ride: the
// order row is the truth. Its status decides whether the card shows Accept and
// Decline or an outcome, and accepting settles the escrow through the triggers in
// shop_credits.sql. The cents here exist so the card can render the amount on
// first paint without a round trip — never so anything can be decided from it.
//
// THE AMOUNT MUST NOT LEAK OUTSIDE THE THREAD. Every surface that previews a
// message has to route an offer through offerPreview() rather than printing the
// body, and the push for it is a dedicated 'offer' notification type whose copy
// names the sender and nothing else (supabase/functions/send-push). A seller
// should learn what they have been offered by opening Laybell, not from a banner
// on a lock screen someone else can read.

const PREFIX = 'laybell://offer?';

export type OfferRef = {
  orderId: string;
  listingId: string;
  cents: number;
  currency: string;
  title: string;
};
export type ParsedOffer = OfferRef & { note: string };

export function offerBody(o: OfferRef, note?: string): string {
  const qs = [
    `order=${encodeURIComponent(o.orderId)}`,
    `listing=${encodeURIComponent(o.listingId)}`,
    `cents=${Math.max(0, Math.round(o.cents))}`,
    `cur=${encodeURIComponent(o.currency || 'USD')}`,
    `title=${encodeURIComponent(o.title || '')}`,
  ].join('&');
  const n = (note ?? '').trim();
  return n ? `${PREFIX}${qs}\n${n}` : `${PREFIX}${qs}`;
}

/** Parse a body into an offer (+ note), or null if it isn't one. */
export function parseOffer(body: string): ParsedOffer | null {
  if (!body) return null;
  const nl = body.indexOf('\n');
  const first = (nl === -1 ? body : body.slice(0, nl)).trim();
  if (!first.startsWith(PREFIX)) return null;

  const params: Record<string, string> = {};
  for (const pair of first.slice(PREFIX.length).split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    params[eq === -1 ? pair : pair.slice(0, eq)] = eq === -1 ? '' : pair.slice(eq + 1);
  }
  const dec = (s: string) => { try { return decodeURIComponent(s || ''); } catch { return s || ''; } };

  const orderId = dec(params.order);
  // Without an order id there is nothing to accept, so this is not an offer card
  // however well-formed the rest of it looks.
  if (!orderId) return null;

  return {
    orderId,
    listingId: dec(params.listing),
    cents: Number(params.cents) || 0,
    currency: dec(params.cur) || 'USD',
    title: dec(params.title),
    note: nl === -1 ? '' : body.slice(nl + 1).trim(),
  };
}

export function isOfferBody(body: string): boolean {
  return !!body && body.trimStart().startsWith(PREFIX);
}
