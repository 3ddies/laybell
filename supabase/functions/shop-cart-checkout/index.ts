import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CORS, userIdFromJwt, safeOrigin, stripe } from '../_shared/stripe.ts';

// ─────────────────────────────────────────────────────────────────────────────
// shop-cart-checkout — start a card purchase of a CART of shop beats on the WEB.
//
// Mirrors stripe-checkout but for N items in ONE Stripe Checkout Session. Validates the cart
// AS THE BUYER (shop_begin_stripe_cart sets every price server-side and records a cart +
// intents), creates one Session with N line items, cart_id in metadata. The money + delivery
// happen later, in stripe-webhook → shop_deliver_stripe_cart (all-or-nothing), keyed on that
// cart. The secret key never leaves this function; the client only gets a redirect URL.
//
// ⚠️ MONEY-ADJACENT. Pairs with shop_stripe_cart.sql + stripe-webhook. Do not deploy to a
// LIVE Stripe key until the money review passes.
//
// Deploy (JWT verification ON — only a signed-in buyer can check out):
//   supabase functions deploy shop-cart-checkout
// ─────────────────────────────────────────────────────────────────────────────

// DEDICATED shop key (same as stripe-checkout) — NOT the live payouts key. TEST for testing,
// live only at go-live. Fail-closed if unset.
const STRIPE_KEY = Deno.env.get('STRIPE_SHOP_SECRET_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const DEFAULT_ORIGIN = Deno.env.get('SHOP_WEB_ORIGIN') ?? 'https://laybell-web.vercel.app';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (!STRIPE_KEY) return json({ error: 'stripe_not_configured' }, 500);
    if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: 'supabase_not_configured' }, 500);

    const uid = userIdFromJwt(req);
    if (!uid) return json({ error: 'unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    const rawItems = Array.isArray(body?.items) ? body.items : null;
    if (!rawItems || rawItems.length === 0) return json({ error: 'cart_empty' });
    if (rawItems.length > 20) return json({ error: 'cart_too_large' });
    // Shape-guard client input before it reaches the RPC (which re-validates everything).
    const clean = rawItems.map((it: any) => ({ listing_id: String(it?.listing_id ?? ''), kind: String(it?.kind ?? '') }));
    if (clean.some((it) => !it.listing_id || (it.kind !== 'sell' && it.kind !== 'lease'))) {
      return json({ error: 'bad_item' });
    }

    // (1) Validate + price + record the cart AS THE BUYER, so auth.uid() and every RPC check
    // (active listing, not own, not already owned, server-set price, de-dupe) run.
    const asUser = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false },
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: begin, error: beginErr } = await asUser
      .rpc('shop_begin_stripe_cart', { p_items: clean });
    // 200 with an error body: supabase-js throws on non-2xx and hides the reason.
    if (beginErr) return json({ error: beginErr.message ?? 'cannot_checkout' });
    if (!begin?.ok) return json({ error: 'cannot_checkout' });

    const cartId = String(begin.cart_id);
    const cartItems = (begin.items ?? []) as Array<{ listing_id: string; kind: string; price_cents: number; title: string; cover_url: string | null }>;
    if (cartItems.length === 0) return json({ error: 'cart_empty' });

    const origin = safeOrigin(req, DEFAULT_ORIGIN);
    const taxOn = (Deno.env.get('SHOP_TAX_ENABLED') ?? '').toLowerCase() === 'true';
    const taxCode = Deno.env.get('STRIPE_TAX_CODE');

    // (2) Build the Session with one line item per cart item. unit_amount IS the server-set
    // price from begin; the webhook re-checks amount_subtotal against the cart intents before
    // delivering, so a tampered client can't pay less and get the beats.
    const params: Record<string, string> = {
      mode: 'payment',
      'metadata[cart_id]': cartId,
      'metadata[buyer_id]': uid,
      'payment_intent_data[metadata][cart_id]': cartId,
      'payment_intent_data[metadata][buyer_id]': uid,
      // /purchases shows the "unlocking…" poll then the downloads; cancel returns to the cart.
      success_url: `${origin}/purchases?cart=${cartId}`,
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

    // (3) Record the session id on the cart (service role).
    const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    await db.rpc('shop_stripe_attach_cart_session', { p_cart_id: cartId, p_session_id: session.id });

    return json({ url: session.url, cart_id: cartId });
  } catch (err) {
    console.error('shop-cart-checkout failed:', String(err));
    return json({ error: String(err) }, 500);
  }
});
