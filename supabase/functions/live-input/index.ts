import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

// Manages Cloudflare Stream LIVE INPUTS for the Live tab — the Stream API token
// never reaches the client. Reuses the same secrets as stream-direct-upload:
//
//   supabase secrets set CF_ACCOUNT_ID=<account id>        # already set for uploads
//   supabase secrets set CF_STREAM_TOKEN=<Stream:Edit token>
//   supabase functions deploy live-input
//
// Request (POST, must carry the user's Supabase auth token):
//   { action: 'create', title?: string }
//     → { inputUid, whipUrl, whepUrl, rtmpsUrl, rtmpsStreamKey, hlsUrl }
//       whipUrl/rtmps* are BROADCASTER SECRETS — the app stores them in
//       live_stream_keys (owner-only RLS), never in the public live_streams row.
//   { action: 'status', inputUid: string }
//     → { connected: boolean }   (is an encoder currently pushing to this input)
//   { action: 'delete', inputUid: string }
//     → { ok: true }             (ownership enforced via the input's meta.creator)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ACCOUNT_ID = Deno.env.get('CF_ACCOUNT_ID');
const CF_TOKEN = Deno.env.get('CF_STREAM_TOKEN');
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/stream/live_inputs`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// Same lightweight JWT read the other Stream functions use.
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

async function cfFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && data?.success !== false, status: res.status, data };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (!ACCOUNT_ID || !CF_TOKEN) return json({ error: 'stream_not_configured' }, 500);
    const uid = userIdFromJwt(req);
    if (!uid) return json({ error: 'unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? 'create');

    if (action === 'create') {
      const title = String(body?.title ?? '').slice(0, 120);
      // Retaining a replay is OPT-IN, and defaults to off.
      //
      // Broadcasting music live is a public performance, which the BMI licence
      // covers. SAVING the broadcast is a REPRODUCTION — a new fixation — and BMI
      // §3.B grants "only public performing rights... and does not grant any
      // reproduction, distribution, or any other intellectual property right(s)".
      // No PRO licence ever covers it. So a saved VOD carrying music sits outside
      // every licence Laybell holds, while a live-only broadcast sits inside them.
      //
      // This is the mistake Twitch made: PRO deals, no reproduction rights, VODs
      // retained by default, then mass DMCA notices in 2020 and thousands of
      // videos pulled with no warning to creators. Defaulting to off costs a
      // feature nobody has asked for yet; defaulting to on costs a claim.
      const saveReplay = body?.saveReplay === true;
      const { ok, data } = await cfFetch('', {
        method: 'POST',
        body: JSON.stringify({
          meta: { name: title || 'Laybell live', creator: uid },
          // 'automatic' saves a VOD after the broadcast; 'off' keeps it ephemeral.
          // Note RTMP playback works either way — HLS is served live regardless,
          // so turning recording off does not break watching the stream.
          recording: saveReplay
            ? { mode: 'automatic', timeoutSeconds: 30, requireSignedURLs: false }
            : { mode: 'off' },
        }),
      });
      const r = data?.result;
      if (!ok || !r?.uid) {
        console.error('cf live_inputs create failed:', JSON.stringify(data?.errors ?? data));
        return json({ error: 'live_input_failed' }, 502);
      }
      // webRTCPlayback.url looks like https://customer-<code>.cloudflarestream.com/<uid>/webRTC/play
      // — reuse its origin to build the deterministic HLS manifest for RTMP mode.
      const whepUrl: string = r?.webRTCPlayback?.url ?? '';
      let hlsUrl = '';
      try {
        hlsUrl = `${new URL(whepUrl).origin}/${r.uid}/manifest/video.m3u8`;
      } catch { /* leave empty; client can fall back to cached subdomain */ }
      return json({
        inputUid: r.uid,
        whipUrl: r?.webRTC?.url ?? '',
        whepUrl,
        rtmpsUrl: r?.rtmps?.url ?? '',
        rtmpsStreamKey: r?.rtmps?.streamKey ?? '',
        hlsUrl,
      });
    }

    // status/delete need the input and an ownership check first.
    const inputUid = String(body?.inputUid ?? '');
    if (!inputUid) return json({ error: 'missing_input_uid' }, 400);
    const { ok, status, data } = await cfFetch(`/${inputUid}`);
    if (status === 404) return json(action === 'delete' ? { ok: true } : { connected: false });
    if (!ok) return json({ error: 'live_input_lookup_failed' }, 502);
    if (data?.result?.meta?.creator !== uid) return json({ error: 'forbidden' }, 403);

    if (action === 'status') {
      const state = data?.result?.status?.current?.state ?? data?.result?.status?.current ?? null;
      return json({ connected: state === 'connected' });
    }
    if (action === 'delete') {
      const del = await cfFetch(`/${inputUid}`, { method: 'DELETE' });
      if (!del.ok && del.status !== 404) return json({ error: 'live_input_delete_failed' }, 502);
      return json({ ok: true });
    }
    return json({ error: 'unknown_action' }, 400);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
