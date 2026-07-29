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
//   { action: 'onboard' } → returns { url } to Stripe's hosted onboarding
//   { action: 'status'  } → returns { connected, payoutsEnabled, detailsSubmitted }
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

// Stripe's API is form-encoded, not JSON.
async function stripe(path: string, body?: Record<string, string>, method = 'POST') {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${STRIPE_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message ?? 'stripe_error');
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

    return json({ error: 'unknown_action' }, 400);
  } catch (err) {
    console.error('stripe-connect failed:', String(err));
    return json({ error: String(err) }, 500);
  }
});
