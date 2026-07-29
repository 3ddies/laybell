import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─────────────────────────────────────────────────────────────────────────────
// stream-sweep — deletes Cloudflare Stream assets that nothing in the database
// points at, so an abandoned upload can't bill storage forever.
//
// WHY THIS EXISTS: the composer PREWARMS a video upload on the details step, which
// means Cloudflare creates (and charges for) the asset before the user has decided
// to post. lib/streamUpload.ts persists every minted uid on-device and settles the
// leftovers on the next launch — that covers a crash or force-quit. This function
// is the backstop for the cases the device can't cover: the app was uninstalled,
// storage was cleared, or the user simply never came back.
//
// SAFETY — an orphan must fail EVERY test before it is touched:
//   • It is not referenced by posts.video_uid, posts.media_url, or
//     ad_creatives.media_url (the only three places a uid can be recorded).
//   • It is not a live recording (`liveInput` set) — those belong to the Live tab
//     and are never referenced by a Stream video uid.
//   • It is older than minAgeHours (default 24). A prewarm that is legitimately
//     in flight right now is unreferenced BY DESIGN, so recent assets are never
//     candidates.
//   • The database read succeeded. A failed reference query aborts the whole run
//     rather than reporting an empty reference set — "we couldn't check" must
//     never look like "nothing uses it".
//
// It is DRY RUN unless you pass apply:true. Run it dry first and read the report.
//
// Deploy:
//   supabase secrets set STREAM_SWEEP_SECRET=<a long random string>
//   supabase functions deploy stream-sweep --no-verify-jwt
//   (CF_ACCOUNT_ID / CF_STREAM_TOKEN are already set for the other Stream fns;
//    SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
//
// Invoke:
//   curl -X POST https://<project>.supabase.co/functions/v1/stream-sweep \
//     -H "x-sweep-secret: <secret>" -H "content-type: application/json" \
//     -d '{"apply":false,"minAgeHours":24}'
//
// Schedule it daily once you trust the dry-run output (Supabase cron / any runner).
// ─────────────────────────────────────────────────────────────────────────────

const ACCOUNT_ID = Deno.env.get('CF_ACCOUNT_ID');
const CF_TOKEN = Deno.env.get('CF_STREAM_TOKEN');
const SWEEP_SECRET = Deno.env.get('STREAM_SWEEP_SECRET');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const CORS = {
  'Access-Control-Allow-Origin': '*', // auth is the shared secret below, not origin
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sweep-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const STREAM_UID = /cloudflarestream\.com\/([A-Za-z0-9]+)\//i;
function uidFromUrl(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(STREAM_UID);
  return m ? m[1] : null;
}

// Every Stream uid the database knows about. Paginated because this grows with the
// catalogue; a throw here aborts the sweep (see the safety note above).
async function referencedUids(db: ReturnType<typeof createClient>): Promise<Set<string>> {
  const refs = new Set<string>();
  const PAGE = 1000;

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('posts')
      .select('video_uid, media_url')
      .or('video_uid.not.is.null,media_url.ilike.*cloudflarestream.com*')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`posts read failed: ${error.message}`);
    for (const row of data ?? []) {
      const r = row as { video_uid: string | null; media_url: string | null };
      if (r.video_uid) refs.add(r.video_uid);
      const u = uidFromUrl(r.media_url);
      if (u) refs.add(u);
    }
    if (!data || data.length < PAGE) break;
  }

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('ad_creatives')
      .select('media_url')
      .ilike('media_url', '%cloudflarestream.com%')
      .range(from, from + PAGE - 1);
    // A missing ad_creatives table (pre-migration project) is not a reason to stop.
    if (error) {
      if (/relation .* does not exist|schema cache/i.test(error.message)) break;
      throw new Error(`ad_creatives read failed: ${error.message}`);
    }
    for (const row of data ?? []) {
      const u = uidFromUrl((row as { media_url: string | null }).media_url);
      if (u) refs.add(u);
    }
    if (!data || data.length < PAGE) break;
  }

  return refs;
}

type CfVideo = { uid: string; created?: string; liveInput?: string; creator?: string; size?: number; status?: { state?: string } };

// Walk the account's video list. Cloudflare pages this with `asc` + `start`, so we
// step backwards from the newest and stop once we're past the age cutoff.
async function listVideos(cutoffMs: number, hardLimit: number): Promise<CfVideo[]> {
  const out: CfVideo[] = [];
  const base = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/stream`;
  let before: string | null = null;

  while (out.length < hardLimit) {
    const qs = new URLSearchParams({ limit: '1000', asc: 'false' });
    if (before) qs.set('before', before);
    const res = await fetch(`${base}?${qs}`, { headers: { Authorization: `Bearer ${CF_TOKEN}` } });
    const data = await res.json();
    if (!res.ok || !data?.success) throw new Error(`cf list failed: ${JSON.stringify(data?.errors ?? data)}`);
    const page: CfVideo[] = data.result ?? [];
    if (!page.length) break;

    for (const v of page) {
      const created = v.created ? Date.parse(v.created) : 0;
      // The list is newest-first, so the first asset older than the cutoff means
      // every one after it is too — but keep collecting, they're the candidates.
      if (created && created > cutoffMs) continue;
      out.push(v);
    }
    const oldest = page[page.length - 1]?.created;
    if (!oldest || page.length < 1000) break;
    before = oldest;
  }
  return out;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // No secret configured = no sweeping. Never fall back to open access on a
  // function whose whole job is deleting media.
  if (!SWEEP_SECRET) return json({ error: 'sweep_not_configured' }, 500);
  if (req.headers.get('x-sweep-secret') !== SWEEP_SECRET) return json({ error: 'unauthorized' }, 401);
  if (!ACCOUNT_ID || !CF_TOKEN) return json({ error: 'stream_not_configured' }, 500);
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: 'supabase_not_configured' }, 500);

  try {
    const body = await req.json().catch(() => ({}));
    const apply = body?.apply === true;
    const minAgeHours = Math.max(1, Number(body?.minAgeHours) || 24);
    const maxDeletes = Math.min(500, Math.max(1, Number(body?.maxDeletes) || 200));

    const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const refs = await referencedUids(db);

    const cutoff = Date.now() - minAgeHours * 3_600_000;
    const candidates = await listVideos(cutoff, 5000);

    const orphans: CfVideo[] = [];
    let skippedLive = 0;
    for (const v of candidates) {
      if (v.liveInput) { skippedLive++; continue; }
      if (refs.has(v.uid)) continue;
      orphans.push(v);
    }

    const report = {
      dryRun: !apply,
      minAgeHours,
      referencedInDatabase: refs.size,
      assetsOlderThanCutoff: candidates.length,
      skippedLiveRecordings: skippedLive,
      orphansFound: orphans.length,
      orphanBytes: orphans.reduce((n, v) => n + (v.size ?? 0), 0),
      deleted: 0,
      failed: [] as string[],
      sample: orphans.slice(0, 25).map((v) => ({ uid: v.uid, created: v.created, creator: v.creator, size: v.size })),
    };

    if (!apply) return json(report);

    for (const v of orphans.slice(0, maxDeletes)) {
      const del = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/stream/${v.uid}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${CF_TOKEN}` },
      });
      if (del.ok || del.status === 404) report.deleted++;
      else report.failed.push(v.uid);
    }
    return json(report);
  } catch (err) {
    console.error('stream-sweep failed:', String(err));
    return json({ error: String(err) }, 500);
  }
});
