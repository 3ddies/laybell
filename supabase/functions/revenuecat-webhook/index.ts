import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// RevenueCat → Supabase entitlement mirror. RevenueCat POSTs subscription events
// here; we write the resulting expiry to profiles.premium_until so a user's Premium
// status is visible across the app (e.g. the supporter badge) and available for
// server-side checks. The app's app_user_id is the Supabase user id (we configure
// RevenueCat with appUserID = uid in lib/purchases.ts).
//
// Setup (see docs/PHASE_C_SETUP.md):
//   1. supabase functions deploy revenuecat-webhook
//   2. supabase secrets set REVENUECAT_WEBHOOK_SECRET=<a long random string>
//   3. In RevenueCat → Integrations → Webhooks, point it at this function's URL and
//      set the Authorization header to "Bearer <the same secret>".
// (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.)

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

serve(async (req) => {
  try {
    // Shared-secret auth: RevenueCat sends the Authorization header we configured.
    const secret = Deno.env.get('REVENUECAT_WEBHOOK_SECRET');
    const auth = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
    if (!secret || auth !== secret) return json({ status: 'error', message: 'unauthorized' }, 401);

    const body = await req.json().catch(() => null);
    const event = body?.event;
    if (!event) return json({ status: 'ignored', reason: 'no event' });

    // The app_user_id is our Supabase uid. Anonymous ids (RevenueCat-generated,
    // prefixed "$RCAnonymousID:") aren't our users — skip them.
    const appUserId: string | undefined = event.app_user_id;
    if (!appUserId || appUserId.startsWith('$RCAnonymousID')) {
      return json({ status: 'ignored', reason: 'no app_user_id' });
    }

    // expiration_at_ms is the new period end for active events, and the (past) end
    // for EXPIRATION. Writing it as-is lets `premium_until > now()` decide active vs
    // expired uniformly. TRANSFER moves the entitlement; we just trust the new state.
    const expMs: number | null = event.expiration_at_ms ?? null;
    const premiumUntil = expMs ? new Date(expMs).toISOString() : null;

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { error } = await admin
      .from('profiles')
      .update({ premium_until: premiumUntil })
      .eq('id', appUserId);
    if (error) return json({ status: 'error', message: error.message }, 500);

    return json({ status: 'ok', type: event.type, premium_until: premiumUntil });
  } catch (e) {
    return json({ status: 'error', message: String(e) }, 500);
  }
});
