import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// log-access — records the CALLER'S OWN IP address against a security-relevant
// event, server-side.
//
// The whole point is that the address is read from the request rather than sent
// by the client. A self-reported IP is worthless in a payment dispute and worse
// than worthless in a law-enforcement matter, so the client cannot supply one:
// this function ignores any address in the body and only trusts the headers the
// edge network sets.
//
// Deploy:  supabase functions deploy log-access
//   Keep the default verify_jwt = true — the platform validates the signature
//   before this code runs, which is what makes reading `sub` from the token safe.
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.
//
// Request (POST, must carry the user's Supabase auth token):
//   { event: 'upload'|'post'|'report'|'shop_download'|'live_start',
//     subjectType?: string, subjectId?: string }
// Response: { ok: true }
//
// Fire-and-forget by design: it NEVER returns an error the caller should act on,
// because failing to log must never block a user from posting or from downloading
// something they paid for.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// The events worth an IP. Deliberately a closed list: this is a security and
// evidence log, not analytics, and an open-ended endpoint would turn into one.
const ALLOWED = new Set(['upload', 'post', 'report', 'shop_download', 'live_start']);

// Same lightweight read the other functions use — safe because verify_jwt has
// already validated the signature upstream.
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

// Headers differ in how much they can be trusted, so record WHICH one was used.
// cf-connecting-ip is written by Cloudflare and cannot be forged by the client.
// x-forwarded-for can be, if an upstream proxy appends rather than overwrites —
// so it is the last resort, and we take the FIRST entry (the original client)
// while noting the weaker provenance.
function clientIp(req: Request): { ip: string | null; source: string | null } {
  const cf = req.headers.get('cf-connecting-ip');
  if (cf) return { ip: cf.trim(), source: 'cf-connecting-ip' };

  const real = req.headers.get('x-real-ip');
  if (real) return { ip: real.trim(), source: 'x-real-ip' };

  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return { ip: first, source: 'x-forwarded-for' };
  }
  return { ip: null, source: null };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (!SUPABASE_URL || !SERVICE_KEY) return json({ ok: false });
    const uid = userIdFromJwt(req);
    if (!uid) return json({ ok: false });

    const body = await req.json().catch(() => ({}));
    const event = String(body?.event ?? '');
    if (!ALLOWED.has(event)) return json({ ok: false });

    const { ip, source } = clientIp(req);
    // No address means nothing worth storing — an event row with a null IP is
    // just noise in a table whose only purpose is addresses.
    if (!ip) return json({ ok: true });

    const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    await db.from('access_log').insert({
      user_id: uid,
      event,
      subject_type: body?.subjectType ? String(body.subjectType).slice(0, 40) : null,
      subject_id: body?.subjectId ? String(body.subjectId).slice(0, 100) : null,
      ip,
      ip_source: source,
      user_agent: (req.headers.get('user-agent') ?? '').slice(0, 300) || null,
    });

    return json({ ok: true });
  } catch (err) {
    // Swallow: logging must never break the action it is logging.
    console.error('log-access failed:', String(err));
    return json({ ok: true });
  }
});
