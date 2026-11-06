import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─────────────────────────────────────────────────────────────────────────────
// stripe-checkout — start a card purchase of a shop beat on the WEB.
//
// Deliberately moves NO money and makes NO delivery. It validates the buy as the
// signed-in user (shop_begin_stripe_order sets the price server-side and records an
// intent), then creates a Stripe Checkout Session for that exact price with the intent
// id in metadata. The money + delivery happen later, in stripe-webhook, keyed on that
// intent. The secret key never leaves this function; the client only gets a redirect URL.
//
// ⚠️ MONEY-ADJACENT. Pairs with shop_stripe.sql + stripe-webhook. Do not deploy to a
// LIVE Stripe key until the money review passes.
//
// Deploy (JWT verification ON — only a signed-in buyer can check out):
//   supabase functions deploy stripe-checkout
// ─────────────────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const STRIPE_KEY = Deno.env.get('STRIPE_SECRET_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
// Fallback return origin if the caller sends no usable Origin header.
const DEFAULT_ORIGIN = Deno.env.get('SHOP_WEB_ORIGIN') ?? 'https://laybell-web.vercel.app';

// Pinned, same as stripe-connect. Stripe can change response shapes under a running
// deployment otherwise, and this is money-adjacent. Bump intentionally.
const STRIPE_VERSION = '2024-06-20';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

function userIdFromJwt(req: Request): string | null {
  try {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    let b64 = (token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
    if (!b64) return null;
    while (b64.length % 4) b64 += '=';
    return JSON.parse(atob(b64)).sub ?? null;
  } catch { return null; }
}

// Only send the buyer back to a Laybell origin. A bad Origin just breaks their return,
// not security, but keep it tidy.
function safeOrigin(req: Request): string {
  const o = req.headers.get('Origin') ?? '';
  try {
    const u = new URL(o);
    if (u.protocol === 'https:' && (u.hostname.endsWith('.vercel.app') || u.hostname === 'laybell.app' || u.hostname.endsWith('.laybell.app'))) {
      return u.origin;
    }
    // localhost for dev
    if ((u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return u.origin;
  } catch { /* fall through */ }
  return DEFAULT_ORIGIN;
}

async function stripe(path: string, body?: Record<string, string>, method = 'POST', idempotencyKey?: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${STRIPE_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Stripe-Version': STRIPE_VERSION,
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method, headers, body: body ? new URLSearchParams(body).toString() : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? 'stripe_error');
    (err as any).code = data?.error?.code ?? null;
    throw err;
  }
  return data;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (!STRIPE_KEY) return json({ error: 'stripe_not_configured' }, 500);
    if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: 'supabase_not_configured' }, 500);

    const uid = userIdFromJwt(req);
    if (!uid) return json({ error: 'unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    const listingId = String(body?.listing_id ?? '');
    const kind = String(body?.kind ?? '');
    if (!listingId || (kind !== 'sell' && kind !== 'lease')) return json({ error: 'bad_request' }, 400);

    // (1) Validate + price + record intent AS THE BUYER, so auth.uid() and all the
    // RPC's own checks (active listing, not own, not already owned, price) run.
    const asUser = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false },
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: begin, error: beginErr } = await asUser
      .rpc('shop_begin_stripe_order', { p_listing_id: listingId, p_kind: kind });
    // 200 with an error body: supabase-js throws on non-2xx and hides the reason.
    if (beginErr) return json({ error: beginErr.message ?? 'cannot_checkout' });
    if (!begin?.ok) return json({ error: 'cannot_checkout' });

    const intentId = String(begin.intent_id);
    const priceCents = Math.floor(Number(begin.price_cents));
    if (!Number.isFinite(priceCents) || priceCents < 50) return json({ error: 'bad_price' });

    // (2) Listing title/cover for a nice Stripe receipt (service-role read, public cols).
    const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: listing } = await db
      .from('shop_listings').select('title, cover_url').eq('id', listingId).maybeSingle();
    const title = `${(listing as any)?.title ?? 'Beat'}${kind === 'lease' ? ' (Lease license)' : ''}`.slice(0, 250);
    const cover = (listing as any)?.cover_url as string | null;

    const origin = safeOrigin(req);

    // (3) Create the Checkout Session. unit_amount IS the server-set price; the webhook
    // re-checks amount_total against the intent before delivering, so a tampered client
    // can't pay less and get the beat.
    const params: Record<string, string> = {
      mode: 'payment',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': title,
      'line_items[0][price_data][unit_amount]': String(priceCents),
      'line_items[0][quantity]': '1',
      'metadata[intent_id]': intentId,
      'metadata[buyer_id]': uid,
      // Mirror onto the PaymentIntent so refund tooling and charge.refunded carry it too.
      'payment_intent_data[metadata][intent_id]': intentId,
      'payment_intent_data[metadata][buyer_id]': uid,
      // /purchases (not /shop/* — that path is an app universal link) shows the
      // "unlocking…" poll then the download; cancel returns to the listing.
      success_url: `${origin}/purchases?checkout=${intentId}`,
      cancel_url: `${origin}/listing/${listingId}?canceled=1`,
    };
    if (cover && /^https:\/\//.test(cover)) params['line_items[0][price_data][product_data][images][0]'] = cover;

    const session = await stripe('checkout/sessions', params);

    // (4) Record the session id on the intent (service role).
    await db.rpc('shop_stripe_attach_session', { p_intent_id: intentId, p_session_id: session.id });

    return json({ url: session.url, intent_id: intentId });
  } catch (err) {
    console.error('stripe-checkout failed:', String(err));
    return json({ error: String(err) }, 500);
  }
});
