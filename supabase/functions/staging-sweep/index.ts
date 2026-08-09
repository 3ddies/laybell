import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Deletes abandoned masters from the private `video-staging` bucket.
//
// WHY THIS EXISTS AS A FUNCTION AND NOT SQL: it used to be
// public.sweep_video_staging() on an hourly pg_cron schedule, deleting straight
// out of storage.objects. Supabase added storage.protect_delete(), which raises
// on any direct DELETE from that table — so from 2026-08-07 the job failed on
// every single run, silently, ~60 times before an audit caught it. Masters are
// multi-GB (a film stages its whole source), so an unswept bucket is a real and
// growing storage bill. Deletion has to go through the Storage API now, and SQL
// cannot make HTTP calls here (pg_net isn't installed) — hence an Edge Function.
//
//   supabase functions deploy staging-sweep
//
// Invoked fire-and-forget at app boot by any signed-in user, exactly like
// stream-reap: the caller only triggers it, the server decides everything.
//
// SAFETY: the only candidates are objects in `video-staging` older than
// RETENTION_HOURS. That bucket holds nothing but upload scratch — the happy path
// already removes each master as soon as Cloudflare has copied it
// (releaseStagedMaster in the upload queue), so anything still here after a day
// belongs to an upload that died. Nothing user-facing ever reads from it.

const RETENTION_HOURS = 24;
const BUCKET = 'video-staging';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) return json({ error: 'not_configured' }, 500);
    const db = createClient(url, key, { auth: { persistSession: false } });

    // Reading storage.objects is still allowed in SQL — only DELETE is blocked —
    // but the storage schema is not exposed over PostgREST, so the read goes
    // through a security-definer RPC rather than a direct table select.
    const { data: rows, error: readErr } = await db
      .rpc('video_staging_stale_paths', { p_hours: RETENTION_HOURS });
    // A failed read must never be treated as "nothing to keep" — bail instead.
    if (readErr) return json({ error: 'read_failed', detail: readErr.message }, 500);

    const paths: string[] = (Array.isArray(rows) ? rows : []).filter(Boolean);
    if (!paths.length) return json({ swept: 0 });

    const { error: rmErr } = await db.storage.from(BUCKET).remove(paths);
    if (rmErr) return json({ error: 'remove_failed', detail: rmErr.message }, 500);

    return json({ swept: paths.length });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
