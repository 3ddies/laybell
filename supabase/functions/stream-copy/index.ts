import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Hands Cloudflare Stream a URL and lets IT fetch the video — the long-video
// upload path, replacing the hand-rolled chunked (tus) uploader.
//
// The phone makes ONE native upload into the private video-staging bucket, then
// calls this with a short-lived signed URL. Cloudflare downloads the master
// datacenter-to-datacenter. No byte offsets, no resume state, nothing for a
// mobile connection to get wrong halfway through.
//
//   supabase functions deploy stream-copy
//
// Request  (POST, must carry the user's Supabase auth token):
//   { url: string, maxDurationSeconds?: number, name?: string }
// Response:
//   { uid: string }
//
// THIS IS THE FILM GATE. Only an active Premium+ subscription may request a
// ceiling past the free window — checked against profiles.premium_plus_until,
// which only the RevenueCat webhook (service role) can write.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ACCOUNT_ID = Deno.env.get('CF_ACCOUNT_ID');
const CF_TOKEN = Deno.env.get('CF_STREAM_TOKEN');

// Must stay in lockstep with FILM_MAX_SEC in lib/entitlements.ts (+ the client's
// true-length cushion: pickers under-report VFR durations and Cloudflare kills
// an encode that runs past the ceiling it was given).
const FILM_CEILING_SEC = 1 * 3600 + 150;
const FREE_CEILING_SEC = 700;

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
    const url = typeof body?.url === 'string' ? body.url : '';
    // Only our own storage may be fetched — this endpoint must never become a
    // way to make Cloudflare pull an arbitrary URL on our account's dime.
    const expectedHost = `${(Deno.env.get('SUPABASE_URL') ?? '').replace(/^https?:\/\//, '')}`;
    if (!url || !expectedHost || !url.startsWith(`https://${expectedHost}/storage/v1/object/sign/video-staging/`)) {
      return json({ error: 'bad_source_url' }, 400);
    }
    const maxDurationSeconds = Math.min(FILM_CEILING_SEC, Math.max(1, Number(body?.maxDurationSeconds) || FILM_CEILING_SEC));

    if (maxDurationSeconds > FREE_CEILING_SEC) {
      const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      const { data: prof } = await admin
        .from('profiles').select('premium_plus_until').eq('id', uid).maybeSingle();
      const until = prof?.premium_plus_until ? Date.parse(prof.premium_plus_until) : 0;
      if (!(until > Date.now())) return json({ error: 'premium_plus_required' }, 403);
    }

    const rawName = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
    const payload: Record<string, unknown> = {
      url,
      creator: uid,
      maxDurationSeconds,
      requireSignedURLs: false,
      ...(rawName ? { meta: { name: rawName } } : {}),
    };

    // Cloudflare 429s this account routinely (error 971, "throttle your request
    // speed"). One unlucky throttle must not cost a completed upload, so ride
    // it out server-side — the file is already safely staged at this point.
    let cf: Response | null = null;
    let data: any = null;
    for (let attempt = 0, delay = 1200; attempt < 4; attempt++, delay *= 2) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, delay));
      cf = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/stream/copy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      data = await cf.json().catch(() => null);
      const codes = (data?.errors ?? []).map((e: any) => e?.code);
      if (cf.status !== 429 && cf.status < 500 && !codes.includes(971)) break;
    }

    if (!cf!.ok || !data?.success || !data?.result?.uid) {
      const codes = (data?.errors ?? []).map((e: any) => e?.code);
      console.error('cf stream/copy failed:', cf!.status, JSON.stringify(data?.errors ?? data));
      if (cf!.status === 429 || codes.includes(971)) return json({ error: 'stream_busy' }, 503);
      // Cloudflare's own words ride back so the app can say something true.
      const msg = (data?.errors ?? []).map((e: any) => e?.message).filter(Boolean).join('; ');
      return json({ error: `stream_copy_failed${msg ? ` — ${msg}` : ` (cf ${cf!.status})`}` }, 502);
    }
    return json({ uid: data.result.uid });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
