import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─────────────────────────────────────────────────────────────────────────────
// stream-backfill — migrates OLD video posts (raw MP4s in Supabase Storage) to
// Cloudflare Stream so they play as adaptive HLS. New posts already go through
// stream-direct-upload; this closes the gap for everything posted before that.
//
// One invocation = one bounded round (so it always fits the function wall
// clock). Each round:
//   1. SWEEP — every post with video_status='processing': ask Cloudflare if
//      encoding finished. Ready → flip media_url to the HLS manifest (playback
//      switches atomically; thumbnail_url is never touched). Errored → mark
//      video_status='error' (media_url still the MP4, playback unaffected).
//      This also heals app-path posts stuck in 'processing' (poster closed the
//      app before its pollStreamReady finished).
//   2. ENQUEUE — up to `batch` legacy posts (video_uid null, media_url not a
//      cloudflarestream URL): Cloudflare copies the MP4 straight from its
//      public Storage URL (server-to-server, no download through us), then the
//      row is stamped video_uid + video_status='processing' +
//      legacy_media_url = the original MP4 URL.
//
// All state lives in the posts row, so the process is resumable and idempotent:
// kill it anywhere and the next round picks up exactly where it left off. Run
// rounds via scripts/stream-backfill.mjs until it reports done.
//
// GATE: this can create Cloudflare assets (costs money) and rewrites posts with
// the service role, so it is NOT callable by app users. The caller must present
// the STREAM_BACKFILL_SECRET header; the anon key satisfies the platform JWT
// check but the secret is the real authorization.
//
//   supabase secrets set STREAM_BACKFILL_SECRET=<long random string>
//   supabase functions deploy stream-backfill
//   (CF_ACCOUNT_ID / CF_STREAM_TOKEN are the same secrets stream-status uses;
//    SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
//
// Request  (POST, Authorization: Bearer <anon key>, x-backfill-secret: <secret>):
//   { batch?: number (1-50, default 10), dryRun?: boolean, sweepOnly?: boolean }
// Response:
//   { ok: true, enqueued, readied, errored, stillProcessing, remaining, done }
//   `done` = nothing left to enqueue AND nothing still encoding.
// ─────────────────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-backfill-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ACCOUNT_ID = Deno.env.get('CF_ACCOUNT_ID');
const CF_TOKEN = Deno.env.get('CF_STREAM_TOKEN');
const SECRET = Deno.env.get('STREAM_BACKFILL_SECRET');

// Gentle pacing between Cloudflare API calls — the global CF API limit is
// 1200 req / 5 min; this keeps a round far under it even at max batch.
const CF_CALL_GAP_MS = 300;
// Bound the per-round sweep so a huge in-flight set can't blow the wall clock.
const SWEEP_CAP = 60;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

async function cfFetch(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/stream${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok && !!data?.success, status: res.status, data };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  try {
    if (!ACCOUNT_ID || !CF_TOKEN) return json({ error: 'stream_not_configured' }, 500);
    if (!SECRET) return json({ error: 'backfill_secret_not_set' }, 500);
    if ((req.headers.get('x-backfill-secret') ?? '') !== SECRET) return json({ error: 'unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    const batch = Math.min(50, Math.max(1, Number(body?.batch) || 10));
    const dryRun = !!body?.dryRun;
    const sweepOnly = !!body?.sweepOnly;

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Filters shared by the candidate scan and the remaining count.
    const candidateFilter = <T>(q: T): T =>
      (q as any)
        .eq('type', 'video')
        .is('video_uid', null)
        .is('video_status', null)
        .not('media_url', 'is', null)
        .not('media_url', 'ilike', '%cloudflarestream.com%');

    let readied = 0;
    let errored = 0;
    let enqueued = 0;

    // ── 1) SWEEP: flip finished encodes over to HLS ──────────────────────────
    const { data: inflight, error: swErr } = await admin
      .from('posts')
      .select('id, video_uid')
      .eq('video_status', 'processing')
      .not('video_uid', 'is', null)
      .order('created_at', { ascending: true })
      .limit(SWEEP_CAP);
    if (swErr) return json({ error: `sweep_query_failed: ${swErr.message}` }, 500);

    if (!dryRun) {
      for (const p of inflight ?? []) {
        const { ok, status, data } = await cfFetch(`/${p.video_uid}`);
        if (!ok) {
          // Asset gone from Cloudflare (deleted uid) → permanent, mark it so we
          // stop polling. Transient API failures just wait for the next round.
          if (status === 404) {
            await admin.from('posts').update({ video_status: 'error' }).eq('id', p.id).eq('video_uid', p.video_uid);
            errored++;
          }
          await sleep(CF_CALL_GAP_MS);
          continue;
        }
        const v = data.result;
        const state: string | null = v?.status?.state ?? null;
        if (v?.readyToStream && v?.playback?.hls) {
          // The atomic playback switch: media_url becomes the HLS manifest.
          // thumbnail_url is deliberately untouched (posters keep working);
          // video_poster stores Cloudflare's own thumb as a bonus.
          await admin.from('posts').update({
            media_url: v.playback.hls,
            video_hls_url: v.playback.hls,
            video_status: 'ready',
            video_poster: v.thumbnail ?? null,
          }).eq('id', p.id).eq('video_uid', p.video_uid);
          readied++;
        } else if (state === 'error') {
          // Encode/download failed (bad source, deleted Storage file…). media_url
          // was never touched, so the post keeps playing the MP4 as before.
          await admin.from('posts').update({ video_status: 'error' }).eq('id', p.id).eq('video_uid', p.video_uid);
          errored++;
        }
        await sleep(CF_CALL_GAP_MS);
      }
    }

    // ── 2) ENQUEUE: ask Cloudflare to copy the next batch of MP4s ────────────
    if (!dryRun && !sweepOnly) {
      const { data: candidates, error: cErr } = await candidateFilter(
        admin.from('posts').select('id, user_id, media_url'),
      )
        // Newest first: recent posts are the ones feeds actually surface.
        .order('created_at', { ascending: false })
        .limit(batch);
      if (cErr) return json({ error: `candidate_query_failed: ${cErr.message}` }, 500);

      for (const p of candidates ?? []) {
        const { ok, data } = await cfFetch('/copy', {
          method: 'POST',
          body: JSON.stringify({
            url: p.media_url,
            // Mirrors stream-direct-upload: public playback, creator-tagged.
            requireSignedURLs: false,
            creator: p.user_id,
            meta: { name: `backfill:${p.id}` },
          }),
        });
        if (!ok || !data?.result?.uid) {
          console.error(`copy failed for post ${p.id}:`, JSON.stringify(data?.errors ?? data));
          // Mark it so the candidate scan stops retrying a permanently bad row
          // every round; the SQL file documents the one-line retry reset.
          await admin.from('posts').update({ video_status: 'error' }).eq('id', p.id).is('video_uid', null);
          errored++;
          await sleep(CF_CALL_GAP_MS);
          continue;
        }
        const uid = data.result.uid as string;
        // Claim the row. `.is('video_uid', null)` makes concurrent runs safe:
        // if another round already claimed it, we lose the race and delete the
        // duplicate Cloudflare asset we just created.
        const { data: claimed } = await admin.from('posts').update({
          video_uid: uid,
          video_status: 'processing',
          legacy_media_url: p.media_url,
        }).eq('id', p.id).is('video_uid', null).select('id');
        if (!claimed?.length) {
          await cfFetch(`/${uid}`, { method: 'DELETE' }).catch(() => {});
        } else {
          enqueued++;
        }
        await sleep(CF_CALL_GAP_MS);
      }
    }

    // ── 3) Progress counts for the driver loop ───────────────────────────────
    const { count: remaining } = await candidateFilter(
      admin.from('posts').select('id', { count: 'exact', head: true }),
    );
    const { count: stillProcessing } = await admin
      .from('posts')
      .select('id', { count: 'exact', head: true })
      .eq('video_status', 'processing')
      .not('video_uid', 'is', null);

    return json({
      ok: true,
      enqueued,
      readied,
      errored,
      stillProcessing: stillProcessing ?? 0,
      remaining: remaining ?? 0,
      done: (remaining ?? 0) === 0 && (stillProcessing ?? 0) === 0,
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
