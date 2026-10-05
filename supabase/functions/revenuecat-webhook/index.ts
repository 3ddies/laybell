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

// ── Beat item products ────────────────────────────────────────────────────────
// Product id → price in cents, for DIRECT per-beat IAP. Same explicit-map rule as
// credits: a product id not listed here delivers nothing, so a spoofed/mispriced
// product can't buy a beat. MUST match lib/pricing.ts (PRICE_TIERS_CENTS) and
// shop_price_tiers() in supabase/sql/shop_iap.sql — one ladder, three mirrors.
const ITEM_TIERS_CENTS = [
  499, 999, 1499, 1999, 2499, 2999, 3499, 3999, 4999, 5999, 6999, 7999,
  9999, 12999, 14999, 19999, 24999, 29999, 39999, 49999, 69999, 99999,
];
const ITEM_PRODUCTS: Record<string, number> = Object.fromEntries(
  ITEM_TIERS_CENTS.map((c) => [`laybell_item_${c}`, c]),
);

// Event types that carry subscription state. ONLY these may touch premium_until.
// This matters: a consumable purchase arrives with expiration_at_ms = null, and
// writing that through would revoke an active Premium subscription because the
// user bought credits. Routing by type is what prevents it.
const SUBSCRIPTION_EVENTS = new Set([
  'INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'CANCELLATION',
  'UNCANCELLATION', 'BILLING_ISSUE', 'SUBSCRIPTION_PAUSED', 'EXPIRATION', 'TRANSFER',
]);

// Structured failure logging. Supabase captures a function's stdout/stderr, so
// a console.error here is the ONLY trace a money failure leaves — without it a
// 500 returns to RevenueCat and disappears. One JSON line per failure, prefixed
// so it can be grepped or alerted on in the dashboard logs.
//
// Deliberately no user email, no auth header, no raw event body: this webhook
// runs service-role and its logs are not a place to accumulate personal data.
function logFailure(stage: string, detail: Record<string, unknown>) {
  console.error(`[money-failure] ${JSON.stringify({ stage, ...detail })}`);
}

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

    // ── Consumable purchases → ledger ───────────────────────────────────────
    if (type === 'NON_RENEWING_PURCHASE') {
      const source = event.store === 'PLAY_STORE' ? 'google_play' : 'apple_iap';
      // event.id is RevenueCat's unique id for this delivery. Passing it as the
      // ledger's external_id is what makes a retried webhook a no-op instead of a
      // double credit — and RevenueCat WILL retry on any non-2xx.
      const externalId = String(event.id ?? `${event.transaction_id}`);

      // (a) Credit packs → fund the buyer's credits.
      const cents = CREDIT_PRODUCTS[productId];
      if (cents) {
        const { data: txId, error } = await admin.rpc('ledger_post', {
          p_kind: 'funding',
          p_legs: [
            { user: appUserId, kind: 'credits', amount_cents: cents },
            { user: null, kind: 'platform', amount_cents: -cents },
          ],
          p_source: source,
          p_external_id: externalId,
          p_memo: `Credits top-up (${productId})`,
          p_metadata: { product_id: productId, store: event.store ?? null },
        });
        if (error) {
          // The user has ALREADY paid Apple at this point. A 500 makes RevenueCat
          // retry, which is the right recovery, but if it keeps failing they are
          // out of pocket with nothing to show — so this must leave a trace.
          logFailure('credit_grant', { user: appUserId, product: productId, cents, error: error.message });
          return json({ status: 'error', message: error.message }, 500);
        }
        return json({ status: 'ok', type, credited_cents: cents, transaction: txId });
      }

      // (b) Beat purchase → deliver the listing named by the purchase's intent.
      // The webhook can't see WHICH listing was bought, so the client tagged the
      // purchase with its intent id (shop_begin_iap_order) as a RevenueCat
      // subscriber attribute. Delivery uses ONLY that tag (scoped to the payer); an
      // untagged purchase is credited back server-side, never guessed to a listing.
      const itemCents = ITEM_PRODUCTS[productId];
      if (itemCents) {
        const intentId: string | null =
          event.subscriber_attributes?.laybellPendingOrder?.value ?? null;
        const { data: result, error } = await admin.rpc('shop_deliver_paid_order', {
          p_buyer: appUserId,
          p_paid_cents: itemCents,
          p_source: source,
          p_external_id: externalId,
          p_txn_id: event.transaction_id ? String(event.transaction_id) : null,
          p_orig_txn_id: event.original_transaction_id ? String(event.original_transaction_id) : null,
          p_intent_id: intentId,
        });
        if (error) {
          // The buyer has paid. A 500 makes RevenueCat retry; delivery is
          // idempotent on the intent, so a retry can't double-deliver.
          logFailure('beat_deliver', { user: appUserId, product: productId, cents: itemCents, intentId, error: error.message });
          return json({ status: 'error', message: error.message }, 500);
        }
        // result.ok === false is a HANDLED outcome (sold out → buyer credited), so
        // acknowledge with 2xx: a non-2xx would make RevenueCat retry a settled case.
        return json({ status: 'ok', type, delivery: result });
      }

      // A consumable id that looks like one of ours but isn't in the maps = mirror
      // drift (a store tier added without updating lib/pricing.ts + ITEM_PRODUCTS +
      // shop_price_tiers). The buyer paid and nothing delivered, so alert rather
      // than silently ignore.
      if (productId.startsWith('laybell_item_') || productId.startsWith('laybell_credits_')) {
        logFailure('unknown_consumable', { user: appUserId, product: productId, store: event.store ?? null });
      }
      return json({ status: 'ignored', reason: `unknown consumable ${productId}` });
    }

    // ── Refund of a consumable → reverse the credits ────────────────────────
    // Not merely bookkeeping: without this a buyer could top up, spend the
    // credits, refund the purchase, and keep what they bought.
    if (type === 'REFUND' || (type === 'CANCELLATION' && (CREDIT_PRODUCTS[productId] || ITEM_PRODUCTS[productId]))) {
      const cents = CREDIT_PRODUCTS[productId];
      if (!cents) {
        // Refund/cancellation of a beat bought via direct IAP. v1 policy ABSORBS
        // (no seller clawback — see docs/BEATS_IAP_PLAN.md): just flip the order to
        // refunded so the buyer loses file access, matched by the processor txn id
        // (transaction_id OR original_transaction_id, scoped per store).
        if (ITEM_PRODUCTS[productId]) {
          const { data: result, error } = await admin.rpc('shop_mark_iap_refunded', {
            p_txn_id: event.transaction_id ? String(event.transaction_id) : null,
            p_orig_txn_id: event.original_transaction_id ? String(event.original_transaction_id) : null,
            p_source: event.store === 'PLAY_STORE' ? 'google_play' : 'apple_iap',
            p_refund_event_id: String(event.id ?? event.transaction_id),
          });
          if (error) {
            logFailure('beat_refund', { user: appUserId, product: productId, error: error.message });
            return json({ status: 'refund_failed', message: error.message }, 200);
          }
          // A known-item refund that matched nothing means the buyer may keep file
          // access — a real support case, so it must leave a trace.
          if (result && (result as { ok?: boolean }).ok === false) {
            logFailure('beat_refund_unmatched', { user: appUserId, product: productId, reason: (result as { reason?: string }).reason });
          }
          return json({ status: 'ok', type, refund: result });
        }
        return json({ status: 'ignored', reason: 'refund of a non-credit product' });
      }

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
        logFailure('refund_reversal', { user: appUserId, product: productId, cents, error: error.message });
        return json({ status: 'refund_failed', message: error.message, user: appUserId }, 200);
      }
      return json({ status: 'ok', type, reversed_cents: cents, transaction: txId });
    }

    // ── Subscription state → premium_until / premium_plus_until ─────────────
    // Guard: a consumable (credit pack or beat item) must NEVER reach this branch
    // — a CANCELLATION of one would otherwise null out premium_until and revoke a
    // real subscriber's Premium. Item CANCELLATIONs are handled in the refund
    // branch above; this is defence in depth.
    if (SUBSCRIPTION_EVENTS.has(type) && !CREDIT_PRODUCTS[productId] && !ITEM_PRODUCTS[productId]) {
      // expiration_at_ms is the new period end for active events, and the (past)
      // end for EXPIRATION. Writing it as-is lets `premium_until > now()` decide
      // active vs expired uniformly.
      const expMs: number | null = event.expiration_at_ms ?? null;
      const until = expMs ? new Date(expMs).toISOString() : null;

      // Each product writes ONLY its own column. Premium+ ($19.99) events must
      // never clobber a separately-active $9.99 subscription's mirror (and vice
      // versa) — the superset lives in is_premium(), which checks both columns.
      // Plus is identified by its entitlement id when RevenueCat sends one, with
      // the product-id prefix as the fallback.
      const entitlements: string[] = Array.isArray(event.entitlement_ids) ? event.entitlement_ids : [];
      const isPlus = entitlements.includes('premium_plus') || productId.startsWith('laybell_premium_plus');
      const patch = isPlus ? { premium_plus_until: until } : { premium_until: until };

      const { error } = await admin
        .from('profiles')
        .update(patch)
        .eq('id', appUserId);
      if (error) {
        logFailure('premium_update', { user: appUserId, type, ...patch, error: error.message });
        return json({ status: 'error', message: error.message }, 500);
      }
      return json({ status: 'ok', type, ...patch });
    }

    // Anything else (SUBSCRIBER_ALIAS, TEST, …) is acknowledged and ignored.
    // Returning 2xx matters: a non-2xx makes RevenueCat retry forever.
    return json({ status: 'ignored', type });
  } catch (e) {
    logFailure('unhandled', { error: String(e) });
    return json({ status: 'error', message: String(e) }, 500);
  }
});
