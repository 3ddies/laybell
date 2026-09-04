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

    // {"mode":"billing"} — what Cloudflare itself says it is STORING, which is
    // the only number the invoice is computed from. Listing assets answers "what
    // is there"; this answers "what am I being charged for", and the two coming
    // apart is exactly the situation worth being able to see. Also lists live
    // inputs, whose recordings bill as stored minutes but are not ordinary
    // videos, so they never show up in a normal asset list.
    if (body?.mode === 'billing') {
      const base = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/stream`;
      const auth = { Authorization: `Bearer ${CF_TOKEN}` };
      // The subscriptions call almost certainly 403s — CF_STREAM_TOKEN is scoped
      // to Stream, and account billing is a different permission. It is tried
      // anyway because if it DOES answer, it names every recurring charge on the
      // account and the question is closed without a dashboard trip. A 403 here
      // is information too: it means the answer can only come from the dashboard.
      const [usageRes, liveRes, subsRes, imgRes] = await Promise.all([
        fetch(`${base}/storage-usage`, { headers: auth }),
        fetch(`${base}/live_inputs`, { headers: auth }),
        fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/subscriptions`, { headers: auth }),
        // Cloudflare IMAGES, which shares the "Images Stream Basic" subscription
        // with Stream. Stream's own usage cannot explain a bill above one block,
        // so the other half of that bundle is the place left to look.
        fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/images/v1/stats`, { headers: auth }),
      ]);
      const usage = await usageRes.json().catch(() => null);
      const live = await liveRes.json().catch(() => null);
      const subs = await subsRes.json().catch(() => null);
      const img = await imgRes.json().catch(() => null);
      return json({
        storageUsage: usageRes.ok ? usage?.result : { httpStatus: usageRes.status, errors: usage?.errors },
        liveInputs: liveRes.ok
          ? { count: (live?.result ?? []).length, uids: (live?.result ?? []).map((l: any) => l?.uid) }
          : { httpStatus: liveRes.status, errors: live?.errors },
        subscriptions: subsRes.ok
          ? (subs?.result ?? []).map((s: any) => ({
              product: s?.rate_plan?.public_name ?? s?.rate_plan?.id,
              price: s?.price,
              currency: s?.currency,
              frequency: s?.frequency,
              state: s?.state,
            }))
          : { httpStatus: subsRes.status, errors: subs?.errors, note: 'token likely lacks billing scope — read it from the dashboard' },
        imagesStored: imgRes.ok
          ? img?.result?.count
          : { httpStatus: imgRes.status, errors: img?.errors },
      });
    }

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
