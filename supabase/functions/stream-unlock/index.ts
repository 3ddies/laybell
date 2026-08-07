import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

// TEMPORARY maintenance function — delete after use.
//
// The stream-tus-upload mint accidentally created assets with requireSignedURLs
// enabled (tus metadata flag semantics: presence = true), so their public HLS
// URLs 401 forever. This flips an asset back to public playback. The action is
// harmless-only (it can only ever make a Laybell video publicly playable, which
// is every Laybell video's intended state), so it requires nothing beyond a
// valid project JWT at the gateway.

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

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (!ACCOUNT_ID || !CF_TOKEN) return json({ error: 'stream_not_configured' }, 500);
    const body = await req.json().catch(() => ({}));
    const uid = typeof body?.uid === 'string' ? body.uid : '';
    if (!uid) return json({ error: 'uid_required' }, 400);

    const cf = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/stream/${uid}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid, requireSignedURLs: false }),
      },
    );
    const data = await cf.json().catch(() => null);
    return json({ ok: cf.ok, status: cf.status, requireSignedURLs: data?.result?.requireSignedURLs ?? null });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
