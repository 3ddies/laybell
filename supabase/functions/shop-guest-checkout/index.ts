import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CORS, safeOrigin, stripe } from '../_shared/stripe.ts';

// ─────────────────────────────────────────────────────────────────────────────
// shop-guest-checkout — start a GUEST (no-account) card purchase of a shop beat on the WEB.
//
// Runs with verify_jwt=false so a browser with NO Laybell account can buy. Validates + prices
// + records a guest intent (service role → shop_begin_stripe_guest_order), then creates a
// Stripe Checkout Session that COLLECTS THE BUYER'S EMAIL, with the guest intent id in
// metadata. The money + delivery happen later in stripe-webhook →
// shop_deliver_stripe_guest_order, and the guest downloads via a secret token (no sign-up).
//
// ⚠️ MONEY-ADJACENT. Pairs with shop_stripe_guest.sql + stripe-webhook. Do not deploy to a
// LIVE Stripe key until the money review passes.
//
// Deploy (JWT verification OFF — guests have no Supabase session):
//   supabase functions deploy shop-guest-checkout --no-verify-jwt
// ─────────────────────────────────────────────────────────────────────────────

const STRIPE_KEY = Deno.env.get('STRIPE_SHOP_SECRET_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const DEFAULT_ORIGIN = Deno.env.get('SHOP_WEB_ORIGIN') ?? 'https://laybell-web.vercel.app';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (!STRIPE_KEY) return json({ error: 'stripe_not_configured' }, 500);
    if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: 'supabase_not_configured' }, 500);

    const body = await req.json().catch(() => ({}));
    const listingId = String(body?.listing_id ?? '');
    const kind = String(body?.kind ?? '');
    if (!listingId || (kind !== 'sell' && kind !== 'lease')) return json({ error: 'bad_request' }, 400);

    const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    // (0) Anti-abuse: per-IP rate limit (this fn is --no-verify-jwt, so anon can hammer it).
    // Checked before any begin/Stripe work so a flood never mints intents or sessions.
    const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim()
            || (req.headers.get('cf-connecting-ip') ?? '').trim();
    const { data: allowed } = await db.rpc('shop_guest_rl_hit', { p_ip: ip });
    if (allowed === false) return json({ error: 'rate_limited' });

    // (1) Validate + price + record a guest intent (service role; no buyer). The RPC sets the
    // price server-side and mints the download token; the webhook re-checks the amount.
    const { data: begin, error: beginErr } = await db.rpc('shop_begin_stripe_guest_order', { p_listing_id: listingId, p_kind: kind });
    if (beginErr) return json({ error: beginErr.message ?? 'cannot_checkout' });
    if (!begin?.ok) return json({ error: 'cannot_checkout' });

    const intentId = String(begin.intent_id);
    const priceCents = Math.floor(Number(begin.price_cents));
    if (!Number.isFinite(priceCents) || priceCents < 50) return json({ error: 'bad_price' });

    // (2) Listing title/cover for a nice Stripe receipt (public cols).
    const { data: listing } = await db.from('shop_listings').select('title, cover_url').eq('id', listingId).maybeSingle();
    const title = `${(listing as any)?.title ?? 'Beat'}${kind === 'lease' ? ' (Lease license)' : ''}`.slice(0, 250);
    const cover = (listing as any)?.cover_url as string | null;

    const origin = safeOrigin(req, DEFAULT_ORIGIN);
    const taxOn = (Deno.env.get('SHOP_TAX_ENABLED') ?? '').toLowerCase() === 'true';
    const taxCode = Deno.env.get('STRIPE_TAX_CODE');

    // (3) Checkout Session. Stripe collects the buyer's email in payment mode (→
    // customer_details.email in the webhook, used to send the download link). unit_amount is
    // the server-set price; the webhook re-checks amount_subtotal before delivering.
    const params: Record<string, string> = {
      mode: 'payment',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': title,
      'line_items[0][price_data][unit_amount]': String(priceCents),
      'line_items[0][quantity]': '1',
      'metadata[guest_intent_id]': intentId,
      'payment_intent_data[metadata][guest_intent_id]': intentId,
      success_url: `${origin}/buy/complete?i=${intentId}`,
      cancel_url: `${origin}/listing/${listingId}?canceled=1`,
    };
    if (cover && /^https:\/\//.test(cover)) params['line_items[0][price_data][product_data][images][0]'] = cover;
    if (taxOn) {
      params['automatic_tax[enabled]'] = 'true';
      params['billing_address_collection'] = 'required';
      params['line_items[0][price_data][tax_behavior]'] = 'exclusive';
      if (taxCode) params['line_items[0][price_data][product_data][tax_code]'] = taxCode;
    }

    const session = await stripe(STRIPE_KEY, 'checkout/sessions', params);
    await db.rpc('shop_stripe_attach_guest_session', { p_intent_id: intentId, p_session_id: session.id });

    return json({ url: session.url, intent_id: intentId });
  } catch (err) {
    console.error('shop-guest-checkout failed:', String(err));
    return json({ error: String(err) }, 500);
  }
});
