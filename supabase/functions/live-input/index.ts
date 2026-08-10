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
      // recording:'automatic' is NOT a "keep a replay" choice — it is the switch
      // that makes the broadcast WATCHABLE at all over HLS.
      //
      // Cloudflare serves live HLS/DASH out of the recording pipeline: "Live
      // playback from recording are required to serve live viewers, which is why
      // Cloudflare doesn't currently provide an option to decouple live playback
      // from recording." There is no mode where the stream plays but nothing is
      // recorded.
      //
      // This was briefly set to 'off' whenever the (now-removed) "Save a replay"
      // switch was off — which was its default — on the belief that HLS was
      // served independently. It is not: every RTMP-ingest broadcast created that
      // way had no manifest, so the Studio encoder and phone-horizontal (Laybell
      // TV) lives could not be watched by anyone. WHIP/WebRTC lives were
      // unaffected, which is why the breakage stayed invisible.
      //
      // The licensing worry that motivated 'off' is real but belongs at the other
      // end: broadcasting music live is a public performance (BMI-licensed),
      // while a RETAINED VOD is a reproduction that BMI §3.B explicitly does not
      // grant — the Twitch-2020 mass-DMCA shape. So Laybell records because it
      // must to serve viewers, and then deletes the recording when the broadcast
      // ends (see the delete action below). Nothing is retained, so there is no
      // reproduction to be claimed against.
      const { ok, data } = await cfFetch('', {
        method: 'POST',
        body: JSON.stringify({
          meta: { name: title || 'Laybell live', creator: uid },
          recording: { mode: 'automatic', timeoutSeconds: 30, requireSignedURLs: false },
        }),
      });
      const r = data?.result;
      if (!ok || !r?.uid) {
        console.error('cf live_inputs create failed:', JSON.stringify(data?.errors ?? data));
        // Hand the real reason back. supabase-js nulls `data` on a non-2xx, so
        // without this the app can only say "non-2xx status code", which is what
        // a failed go-live used to show the host.
        const reason = (data?.errors ?? [])
          .map((e: any) => [e?.code, e?.message].filter(Boolean).join(' '))
          .filter(Boolean).join('; ');
        return json({ error: 'live_input_failed', reason: reason || undefined }, 502);
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
      // Purge the recordings BEFORE the input. Cloudflare only records because
      // live playback requires it (see create) — the VOD it leaves behind is a
      // by-product nobody asked for, and Laybell has no reproduction licence for
      // one carrying music. Deleting the input does NOT take its videos with it:
      // they are ordinary Stream assets that would otherwise sit there billing
      // storage and standing as a retained copy.
      //
      // Best-effort by design: a video that resists deletion must not strand the
      // input (which costs money for as long as it exists), so failures here are
      // logged and the input teardown proceeds regardless. stream-sweep is the
      // backstop for anything left behind.
      let recordingsDeleted = 0;
      try {
        const vids = await cfFetch(`/${inputUid}/videos`);
        for (const v of (vids.data?.result ?? [])) {
          if (!v?.uid) continue;
          const res = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/stream/${v.uid}`,
            { method: 'DELETE', headers: { Authorization: `Bearer ${CF_TOKEN}` } },
          );
          if (res.ok || res.status === 404) recordingsDeleted++;
          else console.error('live recording delete failed:', v.uid, res.status);
        }
      } catch (e) {
        console.error('live recording sweep failed:', inputUid, String(e));
      }
      const del = await cfFetch(`/${inputUid}`, { method: 'DELETE' });
      if (!del.ok && del.status !== 404) return json({ error: 'live_input_delete_failed' }, 502);
      return json({ ok: true, recordingsDeleted });
    }
    return json({ error: 'unknown_action' }, 400);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
