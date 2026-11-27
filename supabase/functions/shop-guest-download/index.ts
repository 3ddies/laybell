import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CORS } from '../_shared/stripe.ts';

// ─────────────────────────────────────────────────────────────────────────────
// shop-guest-download — hand a guest the beat they bought, by their secret download token.
//
// Runs with verify_jwt=false (guests have no Supabase session). The token (a 48-char CSPRNG
// secret from shop_begin_stripe_guest_order) is the credential: shop_guest_deliverable
// validates it against a DELIVERED guest order and returns the private file path, then this
// function mints a SHORT-LIVED signed URL (service role). Storage RLS gates logged-in buyers,
// but a guest has no session, so the server signs on their behalf AFTER the token check.
//
// Deploy: supabase functions deploy shop-guest-download --no-verify-jwt
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: 'not_configured' }, 500);

    const body = await req.json().catch(() => ({}));
    const token = String(body?.token ?? '');
    if (token.length < 24) return json({ error: 'bad_token' }, 400);

    const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    // Validate the token → the delivered guest order's private file path (raises 'not_found'
    // for an invalid or not-yet-delivered token).
    const { data, error } = await db.rpc('shop_guest_deliverable', { p_token: token });
    if (error) return json({ error: 'not_found' }, 404);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.file_path) return json({ error: 'not_found' }, 404);

    // Service role bypasses storage RLS; the signed URL carries content-disposition: attachment.
    const { data: signed, error: sErr } = await db.storage
      .from('shop-files').createSignedUrl(row.file_path as string, 3600, { download: true });
    if (sErr || !signed?.signedUrl) return json({ error: 'sign_failed' }, 500);

    return json({ url: signed.signedUrl, title: (row as any).title ?? null });
  } catch (err) {
    console.error('shop-guest-download failed:', String(err));
    return json({ error: String(err) }, 500);
  }
});
