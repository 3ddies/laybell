import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Drains stream_reap_queue: Cloudflare Stream assets whose posts rows are gone
// (deleted posts, lapsed-subscriber films, cascade-deleted accounts) but whose
// storage still bills. The delete trigger in premium_plus.sql queues the uid;
// this function makes the HTTP call SQL can't (pg_net isn't installed).
//
//   supabase functions deploy stream-reap
//
// Invoked opportunistically at app boot (fire-and-forget, any signed-in user —
// same client-triggered/server-authoritative pattern as the orphan sweep). It
// takes NO parameters and trusts nothing from the caller: the queue itself is
// the only work list, so the worst an abuser gets is cleanup running slightly
// more often. Batched + idempotent — a uid that 404s at Cloudflare (already
// deleted) still clears from the queue.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ACCOUNT_ID = Deno.env.get('CF_ACCOUNT_ID');
const CF_TOKEN = Deno.env.get('CF_STREAM_TOKEN');
const BATCH = 20;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (!ACCOUNT_ID || !CF_TOKEN) return json({ error: 'stream_not_configured' }, 500);
    // Signed-in callers only — same bar as the other stream functions.
    const auth = req.headers.get('Authorization') ?? '';
    if (!auth.startsWith('Bearer ')) return json({ error: 'unauthorized' }, 401);

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: rows } = await admin
      .from('stream_reap_queue').select('uid').order('queued_at').limit(BATCH);
    if (!rows?.length) return json({ status: 'ok', reaped: 0 });

    let reaped = 0;
    for (const { uid } of rows) {
      try {
        const cf = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/stream/${uid}`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${CF_TOKEN}` } },
        );
        // 404 = already gone — clearing the queue row is still correct.
        if (cf.ok || cf.status === 404) {
          await admin.from('stream_reap_queue').delete().eq('uid', uid);
          reaped++;
        }
      } catch { /* transient — the row stays queued for the next drain */ }
    }
    return json({ status: 'ok', reaped, remaining: rows.length - reaped });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
