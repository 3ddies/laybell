import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

// TEMPORARY DIAGNOSTIC — returns Cloudflare's RAW record for one Stream asset,
// so a stuck/failed encode can be explained instead of guessed at. The playback
// CDN only says "500 / 404"; the API says WHY (status.state, errorReasonCode,
// errorReasonText, duration, size, readyToStream).
//
// Gated by the same shared secret as stream-sweep; no user data is touched.
// Delete this function once the upload pipeline is trusted.
//
//   supabase functions deploy stream-debug --no-verify-jwt
//   curl -X POST .../stream-debug -H "x-sweep-secret: …" -d '{"uid":"…"}'

const ACCOUNT_ID = Deno.env.get('CF_ACCOUNT_ID');
const CF_TOKEN = Deno.env.get('CF_STREAM_TOKEN');
const SECRET = Deno.env.get('STREAM_SWEEP_SECRET');

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json' } });
}

serve(async (req) => {
  try {
    if (!ACCOUNT_ID || !CF_TOKEN) return json({ error: 'stream_not_configured' }, 500);
    if (!SECRET || req.headers.get('x-sweep-secret') !== SECRET) return json({ error: 'unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    const uid = typeof body?.uid === 'string' ? body.uid.trim() : '';
    // No uid → list the most recent assets, so "did it even get created?" is
    // answerable too.
    const url = uid
      ? `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/stream/${uid}`
      : `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/stream?limit=8`;

    const cf = await fetch(url, { headers: { Authorization: `Bearer ${CF_TOKEN}` } });
    const data = await cf.json().catch(() => null);
    if (!cf.ok) return json({ httpStatus: cf.status, cfErrors: data?.errors ?? data }, 200);

    const one = (v: any) => ({
      uid: v?.uid,
      created: v?.created,
      duration: v?.duration,
      size: v?.size,
      readyToStream: v?.readyToStream,
      state: v?.status?.state,
      pctComplete: v?.status?.pctComplete,
      errorReasonCode: v?.status?.errorReasonCode,
      errorReasonText: v?.status?.errorReasonText,
      maxDurationSeconds: v?.maxDurationSeconds,
      uploadExpiry: v?.uploadExpiry,
      creator: v?.creator,
    });

    return json(uid ? one(data?.result) : { count: (data?.result ?? []).length, videos: (data?.result ?? []).map(one) });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
