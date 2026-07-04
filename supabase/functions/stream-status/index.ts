import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

// Reports whether a Cloudflare Stream video has finished encoding, and hands back
// its HLS manifest + poster once it has. The app polls this right after upload so
// it can save the post with a playable HLS URL. Read-only; the CF token stays a
// function secret (same CF_ACCOUNT_ID / CF_STREAM_TOKEN as stream-direct-upload).
//
//   supabase functions deploy stream-status
//
// Request  (POST, must carry the user's Supabase auth token):
//   { uid: string }
// Response:
//   { ready: boolean, state: 'ready'|'inprogress'|'queued'|'error'|null,
//     hls: string|null, poster: string|null }

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

// Only signed-in users may poll — keeps randoms from probing the account.
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
    if (!userIdFromJwt(req)) return json({ error: 'unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    const uid = typeof body?.uid === 'string' ? body.uid : '';
    if (!uid) return json({ error: 'uid_required' }, 400);

    const cf = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/stream/${uid}`,
      { headers: { Authorization: `Bearer ${CF_TOKEN}` } },
    );
    const data = await cf.json();
    if (!cf.ok || !data?.success || !data?.result) {
      console.error('cf stream lookup failed:', JSON.stringify(data?.errors ?? data));
      return json({ error: 'lookup_failed' }, 502);
    }
    const v = data.result;
    return json({
      ready: !!v.readyToStream,
      state: v.status?.state ?? null,
      hls: v.playback?.hls ?? null,
      poster: v.thumbnail ?? null,
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
