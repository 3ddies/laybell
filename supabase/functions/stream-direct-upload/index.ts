import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

// Mints a one-time Cloudflare Stream "direct creator upload" URL so the app can
// upload a video straight to Stream — the API token NEVER reaches the client.
// Token + account id live only as function secrets:
//
//   supabase secrets set CF_ACCOUNT_ID=e4c1091ec13c66878d153885373d26fe
//   supabase secrets set CF_STREAM_TOKEN=<your Stream:Edit API token>   # in your TERMINAL, not this file
//   supabase functions deploy stream-direct-upload
//
// Request  (POST, must carry the user's Supabase auth token):
//   { maxDurationSeconds?: number }
// Response:
//   { uploadURL: string, uid: string }
//
// The app POSTs the video file to `uploadURL`, then saves the post with
// video_uid = uid and video_status = 'processing'. A separate webhook (or poll)
// flips status to 'ready' once Cloudflare finishes encoding.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ACCOUNT_ID = Deno.env.get('CF_ACCOUNT_ID');
const CF_TOKEN = Deno.env.get('CF_STREAM_TOKEN');
// Buffer over the app's 3-minute video cap; Stream requires a max duration.
const DEFAULT_MAX = Number(Deno.env.get('CF_MAX_DURATION_SECONDS') ?? '240');

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// Only signed-in users may mint an upload URL — otherwise anyone could hit this
// and run up Stream charges. (Same lightweight JWT read the translate fn uses.)
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
    const uid = userIdFromJwt(req);
    if (!uid) return json({ error: 'unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    const maxDurationSeconds = Math.min(600, Math.max(1, Number(body?.maxDurationSeconds) || DEFAULT_MAX));

    const cf = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/stream/direct_upload`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
        // requireSignedURLs:false → public playback, matching today's public media.
        // creator tags the asset with the uploader for management/analytics.
        body: JSON.stringify({ maxDurationSeconds, requireSignedURLs: false, creator: uid }),
      },
    );
    const data = await cf.json();
    if (!cf.ok || !data?.success || !data?.result?.uploadURL) {
      console.error('cf direct_upload failed:', JSON.stringify(data?.errors ?? data));
      return json({ error: 'stream_upload_failed' }, 502);
    }
    return json({ uploadURL: data.result.uploadURL, uid: data.result.uid });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
