import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

// Mints LiveKit access tokens for STUDIO SESSIONS — the LiveKit API secret never
// reaches a client. Secrets:
//
//   supabase secrets set LIVEKIT_URL=wss://<project>.livekit.cloud
//   supabase secrets set LIVEKIT_API_KEY=<api key>
//   supabase secrets set LIVEKIT_API_SECRET=<api secret>
//   supabase functions deploy livekit-token --no-verify-jwt
//
// (--no-verify-jwt because the web DAW-connector joins as a guest with only a
//  session code — guest requests carry no Supabase JWT. App requests still send
//  one and are verified against studio_session_members.)
//
// Request (POST):
//   App user:  { sessionId: string }                 + Supabase auth Bearer token
//   Web guest: { code: string, name?: string }       (the shareable 6-char code)
// Response:
//   { token, url, room, identity }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const LK_URL = Deno.env.get('LIVEKIT_URL');
const LK_KEY = Deno.env.get('LIVEKIT_API_KEY');
const LK_SECRET = Deno.env.get('LIVEKIT_API_SECRET');
const SB_URL = Deno.env.get('SUPABASE_URL');
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

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

// PostgREST reads with the service role (bypasses RLS — this function does its
// own authorization checks).
async function sbSelect(path: string): Promise<unknown[]> {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_SERVICE!, Authorization: `Bearer ${SB_SERVICE}` },
  });
  if (!res.ok) return [];
  return (await res.json().catch(() => [])) as unknown[];
}

const b64url = (data: Uint8Array | string): string => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

// LiveKit access tokens are plain HS256 JWTs with a `video` grant claim.
async function mintToken(room: string, identity: string, name: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: LK_KEY,
    sub: identity,
    name,
    nbf: now - 10,
    exp: now + 6 * 3600,
    video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
  }));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(LK_SECRET!), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`)));
  return `${header}.${payload}.${b64url(sig)}`;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (!LK_URL || !LK_KEY || !LK_SECRET) return json({ error: 'livekit_not_configured' }, 500);
    const body = await req.json().catch(() => ({}));
    const uid = userIdFromJwt(req);

    let sessionId: string | null = null;
    let identity = '';
    let name = '';

    if (uid && typeof body?.sessionId === 'string' && body.sessionId) {
      // App path: caller must be a member of an OPEN session.
      const rows = await sbSelect(
        `studio_session_members?session_id=eq.${encodeURIComponent(body.sessionId)}&user_id=eq.${uid}&select=session_id,studio_sessions!inner(status)`,
      ) as Array<{ session_id: string; studio_sessions: { status: string } }>;
      if (!rows.length || rows[0].studio_sessions?.status !== 'open') return json({ error: 'not_a_member' }, 403);
      sessionId = body.sessionId;
      identity = uid;
      const profiles = await sbSelect(`profiles?id=eq.${uid}&select=username,name`) as Array<{ username?: string; name?: string }>;
      name = profiles[0]?.name || profiles[0]?.username || 'Artist';
    } else if (typeof body?.code === 'string' && body.code.trim()) {
      // Web DAW-connector path: the session code IS the credential (Zoom-style).
      const code = body.code.trim().toUpperCase();
      const rows = await sbSelect(
        `studio_sessions?join_code=eq.${encodeURIComponent(code)}&status=eq.open&select=id`,
      ) as Array<{ id: string }>;
      if (!rows.length) return json({ error: 'invalid_code' }, 403);
      sessionId = rows[0].id;
      identity = `guest-${crypto.randomUUID().slice(0, 8)}`;
      name = String(body?.name ?? '').slice(0, 40) || 'Studio guest';
    } else {
      return json({ error: 'unauthorized' }, 401);
    }

    const room = `studio-${sessionId}`;
    const token = await mintToken(room, identity, name);
    return json({ token, url: LK_URL, room, identity });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
