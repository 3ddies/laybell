import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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
    // 700 = the 10-minute source max + the client's 90s true-length cushion
    // (see streamCeilingFor in post.tsx): pickers under-report VFR durations,
    // and Cloudflare kills encodes past the minted ceiling AFTER the upload.
    //
    // FILMS may go higher — but LENGTH is the only thing gated here, never the
    // transport. A film compressed under Cloudflare's 200 MB POST cap should
    // ride this path precisely BECAUSE it is the one that has never failed;
    // forcing it onto a heavier transport just to be long would be backwards.
    const FREE_CEILING_SEC = 700;
    const FILM_CEILING_SEC = 1 * 3600 + 150;
    let requested = Math.max(1, Number(body?.maxDurationSeconds) || DEFAULT_MAX);
    if (requested > FREE_CEILING_SEC) {
      const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      const { data: prof } = await admin
        .from('profiles').select('premium_plus_until').eq('id', uid).maybeSingle();
      const until = prof?.premium_plus_until ? Date.parse(prof.premium_plus_until) : 0;
      if (!(until > Date.now())) return json({ error: 'premium_plus_required' }, 403);
      requested = Math.min(FILM_CEILING_SEC, requested);
    }
    const maxDurationSeconds = Math.min(FILM_CEILING_SEC, requested);

    // Cloudflare intermittently 429s Stream API calls (error 971) even at low
    // volume — one unlucky throttle must not fail a user's post. Retry with
    // backoff, total wait ≤ ~10.5s (the app's invoke deadline is 20s).
    let cf: Response | null = null;
    let data: any = null;
    for (let attempt = 0, delay = 3000; attempt < 4; attempt++, delay *= 2) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, delay / 2));
      cf = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/stream/direct_upload`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
          // requireSignedURLs:false → public playback, matching today's public media.
          // creator tags the asset with the uploader for management/analytics.
          body: JSON.stringify({ maxDurationSeconds, requireSignedURLs: false, creator: uid }),
        },
      );
      data = await cf.json().catch(() => null);
      if (cf.status !== 429 && cf.status < 500) break; // success or a real error
    }
    if (!cf!.ok || !data?.success || !data?.result?.uploadURL) {
      console.error('cf direct_upload failed:', cf!.status, JSON.stringify(data?.errors ?? data));
      if (cf!.status === 429) return json({ error: 'stream_busy' }, 503);
      return json({ error: 'stream_upload_failed' }, 502);
    }
    return json({ uploadURL: data.result.uploadURL, uid: data.result.uid });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
