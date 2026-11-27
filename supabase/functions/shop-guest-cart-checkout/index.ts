import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CORS, safeOrigin, stripe } from '../_shared/stripe.ts';

// ─────────────────────────────────────────────────────────────────────────────
// shop-guest-cart-checkout — start a GUEST (no-account) CART card purchase on the WEB.
//
// The guest analogue of shop-cart-checkout. Runs with verify_jwt=false so a browser with NO
// Laybell account can buy N beats at once. Validates + prices + records a guest cart + intents
// (service role → shop_begin_stripe_guest_cart), then creates ONE Stripe Checkout Session with
// N line items that COLLECTS THE BUYER'S EMAIL, with the guest cart id in metadata. The money +
// delivery happen later in stripe-webhook → shop_deliver_stripe_guest_cart (all-or-nothing), and
// the guest downloads every beat via per-item secret tokens (no sign-up).
//
// ⚠️ MONEY-ADJACENT. Pairs with shop_stripe_guest_cart.sql + stripe-webhook. Do not deploy to a
// LIVE Stripe key until the money review passes.
//
// Deploy (JWT verification OFF — guests have no Supabase session):
//   supabase functions deploy shop-guest-cart-checkout --no-verify-jwt
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
    const rawItems = Array.isArray(body?.items) ? body.items : null;
    if (!rawItems || rawItems.length === 0) return json({ error: 'cart_empty' });
    if (rawItems.length > 20) return json({ error: 'cart_too_large' });
    // Shape-guard client input before it reaches the RPC (which re-validates everything).
    const clean = rawItems.map((it: any) => ({ listing_id: String(it?.listing_id ?? ''), kind: String(it?.kind ?? '') }));
    if (clean.some((it) => !it.listing_id || (it.kind !== 'sell' && it.kind !== 'lease'))) {
      return json({ error: 'bad_item' });
    }

    const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    // (0) Anti-abuse: per-IP rate limit (this fn is --no-verify-jwt, so anon can hammer it).
    // Checked before any begin/Stripe work so a flood never mints carts or sessions.
    const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim()
            || (req.headers.get('cf-connecting-ip') ?? '').trim();
    const { data: allowed } = await db.rpc('shop_guest_rl_hit', { p_ip: ip });
    if (allowed === false) return json({ error: 'rate_limited' });

    // (1) Validate + price + record a guest cart (service role; no buyer). The RPC sets every
    // price server-side, de-dupes per listing, and mints a token per item; the webhook re-checks
    // amount_subtotal against the cart intents before delivering.
    const { data: begin, error: beginErr } = await db.rpc('shop_begin_stripe_guest_cart', { p_items: clean });
    if (beginErr) return json({ error: beginErr.message ?? 'cannot_checkout' });
    if (!begin?.ok) return json({ error: 'cannot_checkout' });

    const cartId = String(begin.cart_id);
    const cartItems = (begin.items ?? []) as Array<{ listing_id: string; kind: string; price_cents: number; title: string; cover_url: string | null }>;
    if (cartItems.length === 0) return json({ error: 'cart_empty' });

    const origin = safeOrigin(req, DEFAULT_ORIGIN);
    const taxOn = (Deno.env.get('SHOP_TAX_ENABLED') ?? '').toLowerCase() === 'true';
    const taxCode = Deno.env.get('STRIPE_TAX_CODE');

    // (2) One line item per cart item; unit_amount IS the server-set price. Stripe collects the
    // buyer's email in payment mode (→ customer_details.email in the webhook, for the links).
    const params: Record<string, string> = {
      mode: 'payment',
      'metadata[guest_cart_id]': cartId,
      'payment_intent_data[metadata][guest_cart_id]': cartId,
      success_url: `${origin}/buy/complete?c=${cartId}`,
      cancel_url: `${origin}/cart?canceled=1`,
    };
    cartItems.forEach((it, i) => {
      const price = Math.floor(Number(it.price_cents));
      const title = `${it.title ?? 'Beat'}${it.kind === 'lease' ? ' (Lease license)' : ''}`.slice(0, 250);
      params[`line_items[${i}][price_data][currency]`] = 'usd';
      params[`line_items[${i}][price_data][product_data][name]`] = title;
      params[`line_items[${i}][price_data][unit_amount]`] = String(price);
      params[`line_items[${i}][quantity]`] = '1';
      if (it.cover_url && /^https:\/\//.test(it.cover_url)) {
        params[`line_items[${i}][price_data][product_data][images][0]`] = it.cover_url;
      }
      if (taxOn) {
        params[`line_items[${i}][price_data][tax_behavior]`] = 'exclusive';
        if (taxCode) params[`line_items[${i}][price_data][product_data][tax_code]`] = taxCode;
      }
    });
    if (taxOn) {
      params['automatic_tax[enabled]'] = 'true';
      params['billing_address_collection'] = 'required';
    }

    const session = await stripe(STRIPE_KEY, 'checkout/sessions', params);

    // (3) Record the session id on the cart (reuses the service-role setter).
    await db.rpc('shop_stripe_attach_cart_session', { p_cart_id: cartId, p_session_id: session.id });

    return json({ url: session.url, cart_id: cartId });
  } catch (err) {
    console.error('shop-guest-cart-checkout failed:', String(err));
    return json({ error: String(err) }, 500);
  }
});
