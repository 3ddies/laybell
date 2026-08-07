import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Mints a one-time Cloudflare Stream TUS (resumable) upload URL — the FILMS
// upload path. Basic direct uploads cap at 200 MB per POST; films run to
// multi-GB, so they go through tus: the server creates the upload with
// `?direct_user=true` and the app PATCHes chunks straight to the returned
// Location URL. The API token never reaches the client (same contract as
// stream-direct-upload; same secrets: CF_ACCOUNT_ID / CF_STREAM_TOKEN).
//
//   supabase functions deploy stream-tus-upload
//
// Request  (POST, must carry the user's Supabase auth token):
//   { uploadLength: number, maxDurationSeconds?: number, name?: string }
// Response:
//   { uploadURL: string, uid: string }
//
// THIS ENDPOINT IS THE FILM GATE. Only videos longer than the free 9-minute
// landscape window need tus, so minting here requires an ACTIVE Premium+
// subscription — checked server-side against profiles.premium_plus_until,
// which only the RevenueCat webhook (service role) can write. A modified
// client can lie about its tier all it wants; without this mint it cannot
// upload past the free window.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ACCOUNT_ID = Deno.env.get('CF_ACCOUNT_ID');
const CF_TOKEN = Deno.env.get('CF_STREAM_TOKEN');

// 3 hours + the client's +90s true-length cushion (see streamCeilingFor in
// post.tsx — pickers under-report VFR durations and Cloudflare kills encodes
// past the minted ceiling). Must stay in lockstep with FILM_MAX_SEC in
// lib/entitlements.ts.
const FILM_CEILING_SEC = 3 * 3600 + 150;
// Cloudflare's own input cap for a single video.
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024 * 1024;

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
    const uid = userIdFromJwt(req);
    if (!uid) return json({ error: 'unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    const uploadLength = Math.floor(Number(body?.uploadLength) || 0);
    if (uploadLength <= 0) return json({ error: 'upload_length_required' }, 400);
    if (uploadLength > MAX_UPLOAD_BYTES) return json({ error: 'file_too_large' }, 413);
    const maxDurationSeconds = Math.min(FILM_CEILING_SEC, Math.max(1, Number(body?.maxDurationSeconds) || FILM_CEILING_SEC));

    // The FILM gate: server truth only. premium_plus_until is webhook-written
    // and self-grant is blocked by a trigger, so this cannot be spoofed
    // client-side. tus as a TRANSPORT is open to any signed-in user up to the
    // free tier's own 10-minute ceiling — big files need resumable chunks
    // regardless of tier (the basic POST caps at 200 MB). What Premium+ gates
    // is LENGTH, exactly like the POST path's 600s clamp.
    const FREE_CEILING_SEC = 700; // the 10-min source max + the client's 90s cushion
    if (maxDurationSeconds > FREE_CEILING_SEC) {
      const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      const { data: prof } = await admin
        .from('profiles').select('premium_plus_until').eq('id', uid).maybeSingle();
      const until = prof?.premium_plus_until ? Date.parse(prof.premium_plus_until) : 0;
      if (!(until > Date.now())) return json({ error: 'premium_plus_required' }, 403);
    }

    // Create the tus upload. Cloudflare answers with the one-time upload URL in
    // `Location` and the new asset's id in `stream-media-id`.
    // ONLY maxDurationSeconds. `requiresignedurls` is a tus FLAG — its mere
    // PRESENCE enables signing (the value is ignored), which locked every tus
    // upload behind 401s while the app polled a "ready" video that could never
    // play. Public playback = omit the key entirely.
    //
    // `name` is added ONLY when the client sends one. It is a VALUE key (a
    // dashboard label), not a flag, so unlike requiresignedurls it cannot
    // change upload behaviour — and Laybell's working short-video path has
    // never sent a name, which is the proof that namelessness was never the
    // cause of a failed upload. It exists so the Stream dashboard is auditable
    // by hand when cleaning up after failures.
    const rawName = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
    const meta = [
      `maxDurationSeconds ${btoa(String(maxDurationSeconds))}`,
      ...(rawName ? [`name ${btoa(unescape(encodeURIComponent(rawName)))}`] : []),
    ].join(',');

    // Cloudflare intermittently 429s this endpoint (error 971, "throttle your
    // request speed") — observed on single calls, not just bursts. One unlucky
    // 429 must not fail a user's film, so ride it out server-side: retry with
    // backoff, total wait ≤ ~10.5s (the app's invoke deadline is 20s).
    let cf: Response | null = null;
    for (let attempt = 0, delay = 1500; attempt < 4; attempt++, delay *= 2) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, delay / 2));
      cf = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/stream?direct_user=true`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${CF_TOKEN}`,
            'Tus-Resumable': '1.0.0',
            'Upload-Length': String(uploadLength),
            'Upload-Metadata': meta,
            'Upload-Creator': uid,
          },
        },
      );
      if (cf.status !== 429 && cf.status < 500) break; // success or a real error
      if (attempt < 3) await cf.text().catch(() => ''); // drain before retrying
    }
    const uploadURL = cf!.headers.get('Location');
    const mediaId = cf!.headers.get('stream-media-id');
    if (!cf!.ok || !uploadURL || !mediaId) {
      const body = await cf!.text().catch(() => '');
      console.error('cf tus create failed:', cf!.status, body);
      // Distinct code for exhausted throttling — the app tells the user to
      // wait a moment rather than showing a scary opaque failure.
      if (cf!.status === 429) return json({ error: 'stream_busy' }, 503);
      // Cloudflare's own reason rides back in the error string — the pending
      // card surfaces it verbatim, which is what cracked this the last time a
      // bare "stream_upload_failed" hid three different root causes.
      return json({ error: `stream_upload_failed (cf ${cf!.status}) ${body.slice(0, 160)}` }, 502);
    }
    return json({ uploadURL, uid: mediaId });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
