import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─────────────────────────────────────────────────────────────────────────────
// stripe-connect — creator payout onboarding and status.
//
// WHY STRIPE HOLDS THE MONEY AND LAYBELL DOES NOT
// Creators are paid through Stripe Connect EXPRESS accounts. Stripe collects
// their identity and bank details, runs the KYC, and owns the payout rails.
// Laybell never sees a bank account number, never holds creator funds in its own
// account, and never becomes the party moving money on someone else's behalf.
// That separation is the whole point — it is what keeps a small platform out of
// state money-transmitter licensing.
//
// The one rule this exists to enforce: NEVER sweep creator funds into a
// Laybell-controlled bank account and pay out from there. That is unlicensed
// money transmission, a federal offence under 18 U.S.C. §1960.
//
// ACTIONS
//   { action: 'onboard' }                     → { url } to Stripe's hosted onboarding
//   { action: 'status'  }                     → { connected, payoutsEnabled, detailsSubmitted }
//   { action: 'payout', amountCents: 2500 }   → { payoutId, transferId }
//
// ⚠️ THE PLATFORM STRIPE BALANCE MUST BE FUNDED. A transfer moves money from
// Laybell's Stripe balance to the creator's connected account. Credits are bought
// through Apple and Google, so that money arrives in a BANK account, not in
// Stripe — meaning Stripe's balance has to be topped up before transfers can
// succeed. An unfunded balance surfaces as `balance_insufficient`, which this
// function reverses cleanly, but the creator still sees a failed payout.
//
// Deploy:
//   supabase secrets set STRIPE_SECRET_KEY=sk_test_…
//   supabase functions deploy stripe-connect
// ─────────────────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const STRIPE_KEY = Deno.env.get('STRIPE_SECRET_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
// Used to call RPCs AS THE SIGNED-IN USER, so their own auth checks still run.
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
// Where Stripe returns the user after onboarding. A deep link back into the app.
const RETURN_URL = Deno.env.get('STRIPE_CONNECT_RETURN_URL') ?? 'https://laybell.app/payouts';

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

// Pinned deliberately. Without this header Stripe uses whatever default version
// the account happens to be on, which means Stripe can change response shapes
// under a running deployment — and this code now moves money. Bump it
// intentionally, after reading the changelog, never by accident.
const STRIPE_VERSION = '2024-06-20';

// Stripe's API is form-encoded, not JSON.
//
// `idempotencyKey` is what makes a retried transfer safe: Stripe returns the
// ORIGINAL result for a repeated key rather than performing the action twice. A
// network timeout on a transfer is otherwise indistinguishable from a failure,
// and retrying without a key pays the creator twice.
async function stripe(
  path: string,
  body?: Record<string, string>,
  method = 'POST',
  idempotencyKey?: string,
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${STRIPE_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Stripe-Version': STRIPE_VERSION,
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers,
    body: body ? new URLSearchParams(body).toString() : undefined,
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
    const action = String(body?.action ?? 'status');

    const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    // The creator's Stripe account id, if they've started onboarding.
    const { data: prof } = await db
      .from('profiles').select('stripe_account_id').eq('id', uid).maybeSingle();
    let acct: string | null = (prof as any)?.stripe_account_id ?? null;

    if (action === 'status') {
      if (!acct) return json({ connected: false, payoutsEnabled: false, detailsSubmitted: false });
      const a = await stripe(`accounts/${acct}`, undefined, 'GET');
      return json({
        connected: true,
        // payouts_enabled is the ONLY field that means "this person can actually
        // be paid". details_submitted just means they finished the form —
        // Stripe may still be verifying, and paying out before it flips true
        // fails at the transfer rather than at the click.
        payoutsEnabled: !!a.payouts_enabled,
        detailsSubmitted: !!a.details_submitted,
      });
    }

    if (action === 'onboard') {
      if (!acct) {
        // Express: Stripe runs onboarding and identity verification, and shows the
        // creator a limited dashboard. Custom would mean Laybell collecting
        // government IDs itself — more control, far more compliance burden, and
        // no benefit here.
        const created = await stripe('accounts', {
          type: 'express',
          country: 'US',
          'capabilities[transfers][requested]': 'true',
          // Metadata, not authority: the Laybell user id is recorded on the Stripe
          // account so support can match them up, but our own profiles row stays
          // the source of truth.
          'metadata[laybell_user_id]': uid,
        });
        acct = created.id as string;
        const { error } = await db.from('profiles').update({ stripe_account_id: acct }).eq('id', uid);
        // If we can't persist the id we'd orphan the Stripe account and create a
        // fresh one on the next attempt — so fail loudly instead.
        if (error) return json({ error: 'could_not_save_account' }, 500);
      }

      const link = await stripe('account_links', {
        account: acct,
        refresh_url: RETURN_URL,
        return_url: RETURN_URL,
        type: 'account_onboarding',
      });
      return json({ url: link.url });
    }

    if (action === 'payout') {
      if (!acct) return json({ error: 'no_connected_account' }, 400);
      const amountCents = Math.floor(Number(body?.amountCents ?? 0));
      if (!Number.isFinite(amountCents) || amountCents <= 0) {
        return json({ error: 'invalid_amount' }, 400);
      }

      // payouts_enabled is the only field that means the creator can actually be
      // paid. Checking it here turns a confusing failed payout into a clear
      // "finish your onboarding".
      const a = await stripe(`accounts/${acct}`, undefined, 'GET');
      if (!a.payouts_enabled) return json({ error: 'payouts_not_enabled' }, 400);

      // request_payout runs as the CALLER, not the service role, so its
      // auth.uid() checks, its balance check and its one-pending-payout
      // constraint all apply. Reaching for the service role here would bypass
      // exactly the guards that make this safe.
      const asUser = createClient(SUPABASE_URL, ANON_KEY, {
        auth: { persistSession: false },
        global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
      });
      const { data: payoutId, error: reqErr } = await asUser
        .rpc('request_payout', { p_amount_cents: amountCents });
      if (reqErr || !payoutId) {
        // These come back as Postgres exception messages; pass the recognisable
        // ones through so the app can say something specific.
        return json({ error: reqErr?.message ?? 'payout_request_failed' }, 400);
      }

      // The ledger is already debited. From here every failure path must either
      // complete the transfer or reverse that debit — never simply return.
      try {
        const transfer = await stripe(
          'transfers',
          {
            amount: String(amountCents),
            currency: 'usd',
            destination: acct,
            'metadata[laybell_payout_id]': String(payoutId),
            'metadata[laybell_user_id]': uid,
          },
          'POST',
          // The payout row's uuid IS the idempotency key. A retry of this exact
          // payout returns Stripe's original transfer instead of creating a
          // second one.
          `laybell_payout_${payoutId}`,
        );

        await db.rpc('settle_payout', {
          p_payout_id: payoutId,
          p_status: 'paid',
          p_transfer_id: transfer.id,
        });
        return json({ payoutId, transferId: transfer.id });
      } catch (err) {
        const reason = String((err as any)?.code ?? err ?? 'transfer_failed');
        // Give the money back. If THIS fails the payout is stuck 'pending' and
        // the creator's balance is short — the query for that case is in
        // payouts.sql, and it's why the stuck-pending check exists.
        await db.rpc('settle_payout', {
          p_payout_id: payoutId,
          p_status: 'failed',
          p_reason: reason,
        });
        console.error('transfer failed, reversed:', payoutId, reason);
        return json({ error: 'transfer_failed', reason }, 400);
      }
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (err) {
    console.error('stripe-connect failed:', String(err));
    return json({ error: String(err) }, 500);
  }
});
