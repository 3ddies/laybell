import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// RevenueCat → Supabase. Two jobs, and they must not be confused with each other:
//
//   SUBSCRIPTIONS (Premium)  → mirror the expiry into profiles.premium_until
//   CONSUMABLES  (Credits)   → post a funding transaction into the ledger
//
// The app's app_user_id is the Supabase user id (lib/purchases.ts configures
// RevenueCat with appUserID = uid).
//
// Setup (see docs/PHASE_C_SETUP.md):
//   1. supabase functions deploy revenuecat-webhook
//   2. supabase secrets set REVENUECAT_WEBHOOK_SECRET=<a long random string>
//   3. RevenueCat → Integrations → Webhooks: point at this function's URL and set
//      the Authorization header to "Bearer <the same secret>".
// (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.)

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// ── Credit products ─────────────────────────────────────────────────────────
// Product id → credits granted, in cents. An EXPLICIT map, deliberately: deriving
// the amount from the event's price field would let a mispriced or spoofed store
// product mint arbitrary credits. If a product id isn't listed here, nothing is
// granted — a missing entry is a no-op, never a guess.
//
// These ids must match exactly what you create in App Store Connect and Play
// Console. Keep them identical across both stores.
const CREDIT_PRODUCTS: Record<string, number> = {
  laybell_credits_499: 499,
  laybell_credits_999: 999,
  laybell_credits_1999: 1999,
  laybell_credits_4999: 4999,
  laybell_credits_9999: 9999,
};

// Event types that carry subscription state. ONLY these may touch premium_until.
// This matters: a consumable purchase arrives with expiration_at_ms = null, and
// writing that through would revoke an active Premium subscription because the
// user bought credits. Routing by type is what prevents it.
const SUBSCRIPTION_EVENTS = new Set([
  'INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'CANCELLATION',
  'UNCANCELLATION', 'BILLING_ISSUE', 'SUBSCRIPTION_PAUSED', 'EXPIRATION', 'TRANSFER',
]);

serve(async (req) => {
  try {
    // Shared-secret auth: RevenueCat sends the Authorization header we configured.
    const secret = Deno.env.get('REVENUECAT_WEBHOOK_SECRET');
    const auth = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
    if (!secret || auth !== secret) return json({ status: 'error', message: 'unauthorized' }, 401);

    const body = await req.json().catch(() => null);
    const event = body?.event;
    if (!event) return json({ status: 'ignored', reason: 'no event' });

    // app_user_id is our Supabase uid. RevenueCat-generated anonymous ids aren't
    // our users.
    const appUserId: string | undefined = event.app_user_id;
    if (!appUserId || appUserId.startsWith('$RCAnonymousID')) {
      return json({ status: 'ignored', reason: 'no app_user_id' });
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const type: string = String(event.type ?? '');
    const productId: string = String(event.product_id ?? '');

    // ── Consumable credits → ledger ─────────────────────────────────────────
    if (type === 'NON_RENEWING_PURCHASE') {
      const cents = CREDIT_PRODUCTS[productId];
      if (!cents) {
        return json({ status: 'ignored', reason: `unknown credit product ${productId}` });
      }

      const source = event.store === 'PLAY_STORE' ? 'google_play' : 'apple_iap';
      // event.id is RevenueCat's unique id for this delivery. Passing it as the
      // ledger's external_id is what makes a retried webhook a no-op instead of a
      // double credit — and RevenueCat WILL retry on any non-2xx.
      const { data: txId, error } = await admin.rpc('ledger_post', {
        p_kind: 'funding',
        p_legs: [
          { user: appUserId, kind: 'credits', amount_cents: cents },
          { user: null, kind: 'platform', amount_cents: -cents },
        ],
        p_source: source,
        p_external_id: String(event.id ?? `${event.transaction_id}`),
        p_memo: `Credits top-up (${productId})`,
        p_metadata: { product_id: productId, store: event.store ?? null },
      });
      if (error) return json({ status: 'error', message: error.message }, 500);
      return json({ status: 'ok', type, credited_cents: cents, transaction: txId });
    }

    // ── Refund of a consumable → reverse the credits ────────────────────────
    // Not merely bookkeeping: without this a buyer could top up, spend the
    // credits, refund the purchase, and keep what they bought.
    if (type === 'REFUND' || (type === 'CANCELLATION' && CREDIT_PRODUCTS[productId])) {
      const cents = CREDIT_PRODUCTS[productId];
      if (!cents) return json({ status: 'ignored', reason: 'refund of a non-credit product' });

      const { data: txId, error } = await admin.rpc('ledger_post', {
        p_kind: 'refund',
        p_legs: [
          { user: appUserId, kind: 'credits', amount_cents: -cents },
          { user: null, kind: 'platform', amount_cents: cents },
        ],
        p_source: event.store === 'PLAY_STORE' ? 'google_play' : 'apple_iap',
        p_external_id: `refund:${event.id ?? event.transaction_id}`,
        p_memo: `Credits refund (${productId})`,
        p_metadata: { product_id: productId, store: event.store ?? null },
      });
      // A refund can legitimately fail if the balance is already spent — the
      // ledger refuses to drive an account negative. Surface it rather than
      // swallowing: that is a real support case, not a glitch.
      if (error) {
        return json({ status: 'refund_failed', message: error.message, user: appUserId }, 200);
      }
      return json({ status: 'ok', type, reversed_cents: cents, transaction: txId });
    }

    // ── Subscription state → premium_until ──────────────────────────────────
    if (SUBSCRIPTION_EVENTS.has(type)) {
      // expiration_at_ms is the new period end for active events, and the (past)
      // end for EXPIRATION. Writing it as-is lets `premium_until > now()` decide
      // active vs expired uniformly.
      const expMs: number | null = event.expiration_at_ms ?? null;
      const premiumUntil = expMs ? new Date(expMs).toISOString() : null;

      const { error } = await admin
        .from('profiles')
        .update({ premium_until: premiumUntil })
        .eq('id', appUserId);
      if (error) return json({ status: 'error', message: error.message }, 500);
      return json({ status: 'ok', type, premium_until: premiumUntil });
    }

    // Anything else (SUBSCRIBER_ALIAS, TEST, …) is acknowledged and ignored.
    // Returning 2xx matters: a non-2xx makes RevenueCat retry forever.
    return json({ status: 'ignored', type });
  } catch (e) {
    return json({ status: 'error', message: String(e) }, 500);
  }
});
