import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─────────────────────────────────────────────────────────────────────────────
// stripe-webhook — deliver (or refund) a web card purchase of a shop beat.
//
// Stripe calls this with NO Supabase JWT, so it deploys with --no-verify-jwt and the
// Stripe SIGNATURE is the authentication: every event is HMAC-verified against
// STRIPE_WEBHOOK_SECRET before anything runs. Delivery itself is all in
// shop_deliver_stripe_order (service role, idempotent on the Stripe event id); this
// function only orchestrates: verify → deliver → refund the card if it couldn't deliver.
//
// RETRY SEMANTICS: any transient failure returns 5xx so Stripe retries. The deliver RPC
// is idempotent on event.id and returns the recorded outcome, so a retry re-attempts a
// refund that a prior attempt recorded as owed ('failed') but could not complete — the
// card never gets charged twice and a failed delivery never strands the buyer's money.
//
// ⚠️ MONEY CODE. Pairs with shop_stripe.sql + stripe-checkout. Do not point a LIVE
// Stripe webhook at this until the money review passes.
//
// Deploy (JWT OFF — Stripe can't send a Supabase JWT; the signature is the auth):
//   supabase secrets set STRIPE_SHOP_SECRET_KEY=sk_test_…   # the shop's OWN key; TEST for testing
//   supabase functions deploy stripe-webhook --no-verify-jwt
//   supabase functions deploy stripe-checkout
//   # then, IN THE MATCHING STRIPE MODE (test), create a webhook endpoint pointing at the
//   #   stripe-webhook URL for events checkout.session.completed,
//   #   checkout.session.async_payment_succeeded, charge.refunded → set its signing
//   #   secret:  supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_…
//   # (the webhook endpoint's mode must match STRIPE_SHOP_SECRET_KEY's mode.)
// ─────────────────────────────────────────────────────────────────────────────

// DEDICATED shop key (same one stripe-checkout uses for refunds) — NOT the shared
// STRIPE_SECRET_KEY, which is LIVE and powers payouts. Set STRIPE_SHOP_SECRET_KEY to a
// TEST key for testing, live only at go-live. Fail-closed if unset.
const STRIPE_KEY = Deno.env.get('STRIPE_SHOP_SECRET_KEY');
const WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const STRIPE_VERSION = '2024-06-20';
const enc = new TextEncoder();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// Constant-time compare so a verifier can't be timing-probed for the right signature.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
// Verify Stripe's `t=…,v1=…` signature header against the RAW body, HMAC-SHA256 with the
// endpoint secret, inside a replay window. This is the entire authentication of the
// webhook, so it fails closed on anything unexpected.
async function verifyStripeSig(raw: string, header: string, secret: string, toleranceSec = 300): Promise<boolean> {
  if (!header) return false;
  const items = header.split(',').map((s) => s.split('='));
  const t = items.find((i) => i[0] === 't')?.[1];
  const sigs = items.filter((i) => i[0] === 'v1').map((i) => i[1]);
  if (!t || sigs.length === 0) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${raw}`));
  const expected = hex(mac);
  return sigs.some((s) => timingSafeEqual(s, expected));
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
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
  if (!WEBHOOK_SECRET || !STRIPE_KEY || !SUPABASE_URL || !SERVICE_KEY) {
    console.error('stripe-webhook not configured');
    return new Response('not_configured', { status: 500 });
  }

  const raw = await req.text();
  const ok = await verifyStripeSig(raw, req.headers.get('Stripe-Signature') ?? '', WEBHOOK_SECRET);
  if (!ok) return new Response('bad_signature', { status: 400 });

  let event: any;
  try { event = JSON.parse(raw); } catch { return new Response('bad_json', { status: 400 }); }

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const s = event.data.object;
      // A session can complete 'unpaid' for async methods; a later *_succeeded event
      // carries the payment. Only deliver on a paid session.
      if (s.payment_status && s.payment_status !== 'paid') {
        return json({ received: true, ignored: 'unpaid' });
      }
      const intentId = s.metadata?.intent_id ?? null;
      const pi = typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent?.id ?? null);
      const amount = Math.floor(Number(s.amount_total));

      const { data: res, error } = await db.rpc('shop_deliver_stripe_order', {
        p_intent_id: intentId, p_event_id: event.id, p_payment_intent_id: pi, p_paid_cents: amount,
      });
      if (error) { console.error('deliver_failed', event.id, error.message); return new Response('deliver_error', { status: 500 }); }

      // Couldn't deliver (sold out, price mismatch, slot taken, no intent, or a prior
      // failed attempt) → refund the card. Idempotency key on the event makes a retried
      // refund return Stripe's original refund rather than a second one.
      if (res?.refund) {
        if (!pi) {
          // Must refund but the event carried no PaymentIntent — we can't auto-refund, and
          // retrying can't change that. Fail LOUD (never silently keep an undeliverable charge)
          // so a human can refund it; the payment row stays outcome='failed' as the record.
          console.error('REFUND OWED BUT NO payment_intent — MANUAL REFUND NEEDED', event.id, 'reason:', res.reason);
          return json({ received: true, delivered: false, reason: res.reason ?? null, needs_manual_refund: true });
        }
        try {
          await stripe('refunds', { payment_intent: pi, 'metadata[laybell_reason]': String(res.reason ?? 'undeliverable') }, 'POST', `refund_${event.id}`);
          await db.rpc('shop_stripe_mark_refunded', { p_event_id: event.id });
          console.log('refunded undeliverable purchase', event.id, res.reason);
        } catch (rerr) {
          console.error('refund_failed', event.id, String(rerr));
          return new Response('refund_error', { status: 500 }); // Stripe retries; deliver RPC idempotent → retries the refund
        }
      }
      return json({ received: true, delivered: !!res?.delivered, reason: res?.reason ?? null });
    }

    // A refund issued from the Stripe dashboard for a delivered order → revoke file access.
    if (event.type === 'charge.refunded') {
      const c = event.data.object;
      const pi = typeof c.payment_intent === 'string' ? c.payment_intent : (c.payment_intent?.id ?? null);
      if (pi) {
        const { error } = await db.rpc('shop_stripe_refund_delivered', { p_payment_intent_id: pi });
        if (error) { console.error('refund_delivered_failed', pi, error.message); return new Response('refund_delivered_error', { status: 500 }); }
      }
      return json({ received: true });
    }

    return json({ received: true, ignored: event.type });
  } catch (err) {
    console.error('stripe-webhook failed:', event?.id, String(err));
    return new Response('error', { status: 500 });
  }
});
