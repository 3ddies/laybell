import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

// Deletes a Cloudflare Stream video so a deleted post (or an abandoned prewarm)
// doesn't linger as paid storage. Ownership is enforced via the `creator` tag we
// set at upload time (the uploader's Supabase user id) — a caller can only delete
// assets they created, so knowing a random uid isn't enough. Idempotent: an
// already-gone asset reports success. CF token stays a function secret.
//
//   supabase functions deploy stream-delete
//
// Request (POST, must carry the user's Supabase auth token):
//   { uid: string }
// Response: { ok: true } | { error }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ACCOUNT_ID = Deno.env.get('CF_ACCOUNT_ID');
const CF_TOKEN = Deno.env.get('CF_STREAM_TOKEN');

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function userIdFromJwt(req: Request): string | null {
  try {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    let b64 = (token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
    if (!b64) return null;
    while (b64.length % 4) b64 += '=';
    const claims = JSON.parse(atob(b64));
    return typeof claims.sub === 'string' ? claims.sub : null;
  } catch {
    return null;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (!ACCOUNT_ID || !CF_TOKEN) return json({ error: 'stream_not_configured' }, 500);
    const callerUid = userIdFromJwt(req);
    if (!callerUid) return json({ error: 'unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    const uid = typeof body?.uid === 'string' ? body.uid : '';
    if (!uid) return json({ error: 'uid_required' }, 400);

    const base = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/stream/${uid}`;
    const auth = { Authorization: `Bearer ${CF_TOKEN}` };

    // Verify ownership via the asset's `creator` tag. A 404 means it's already gone.
    const look = await fetch(base, { headers: auth });
    if (look.status === 404) return json({ ok: true });
    const data = await look.json();
    if (!look.ok || !data?.success || !data?.result) {
      console.error('cf stream lookup failed:', JSON.stringify(data?.errors ?? data));
      return json({ error: 'lookup_failed' }, 502);
    }
    if (data.result.creator && data.result.creator !== callerUid) {
      return json({ error: 'forbidden' }, 403);
    }

    const del = await fetch(base, { method: 'DELETE', headers: auth });
    if (del.status === 404 || del.ok) return json({ ok: true });
    const derr = await del.json().catch(() => ({}));
    console.error('cf stream delete failed:', JSON.stringify(derr?.errors ?? derr));
    return json({ error: 'delete_failed' }, 502);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
