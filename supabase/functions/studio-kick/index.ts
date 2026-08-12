import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

// Removes one participant from a studio session, on the host's authority.
//
//   supabase functions deploy studio-kick
//
// Deployed WITH jwt verification (unlike livekit-token, which is --no-verify-jwt
// so the web DAW connector can join on a session code alone). Nothing here is
// reachable without a Supabase session, and the host check below is done again
// server-side regardless.
//
// Request (POST):  { sessionId: string, identity: string }
// Response:        { ok: true, kind: 'member' | 'guest' }
//
// `identity` is a user id for an app member and `guest-xxxxxxxx` for the web
// DAW connector — the same identity LiveKit knows them by, which is what the
// host screen already has in hand.
//
// TWO HALVES, AND BOTH ARE NEEDED. Deleting the membership row alone leaves
// them connected and audible until they choose to leave; it only stops the NEXT
// token. Calling LiveKit alone disconnects them and lets them walk straight
// back in, because the token endpoint would still find their membership. So
// this removes the seat first, then closes the connection: if the LiveKit call
// fails the seat is still gone and their next reconnect is refused, which is
// the safer way round to fail.

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// Verified against GoTrue rather than decoded locally. The gateway already
// verifies for this function, but the membership work below runs with the
// service role and bypasses RLS — worth not depending on a single gate.
async function verifiedUserId(req: Request): Promise<string | null> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    const res = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: SB_SERVICE!, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const user = await res.json().catch(() => null) as { id?: string } | null;
    return typeof user?.id === 'string' ? user.id : null;
  } catch {
    return null;
  }
}

async function sbSelect(path: string): Promise<unknown[]> {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_SERVICE!, Authorization: `Bearer ${SB_SERVICE}` },
  });
  if (!res.ok) return [];
  return (await res.json().catch(() => [])) as unknown[];
}

async function sbWrite(method: 'DELETE' | 'PATCH', path: string, body?: unknown): Promise<boolean> {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SB_SERVICE!,
      Authorization: `Bearer ${SB_SERVICE}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.ok;
}

const b64url = (data: Uint8Array | string): string => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

// An ADMIN token, scoped to this one room. Not a join grant — it never enters
// the room, it only authorises the server API call below.
async function mintAdminToken(room: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: LK_KEY,
    sub: 'studio-kick',
    nbf: now - 10,
    exp: now + 60,
    video: { room, roomAdmin: true },
  }));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(LK_SECRET!), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`)));
  return `${header}.${payload}.${b64url(sig)}`;
};

// LiveKit's server API is Twirp over the same host as the signalling URL, which
// is configured as wss:// — hence the scheme swap.
async function removeParticipant(room: string, identity: string): Promise<boolean> {
  const http = LK_URL!.replace(/^ws/, 'http').replace(/\/+$/, '');
  try {
    const res = await fetch(`${http}/twirp/livekit.RoomService/RemoveParticipant`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await mintAdminToken(room)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ room, identity }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (!LK_URL || !LK_KEY || !LK_SECRET) return json({ error: 'livekit_not_configured' }, 500);

    const uid = await verifiedUserId(req);
    if (!uid) return json({ error: 'unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
    const identity = typeof body?.identity === 'string' ? body.identity.trim() : '';
    if (!UUID_RE.test(sessionId) || !identity) return json({ error: 'bad_request' }, 400);

    // Caller must be the host, and the session must still be open.
    const sessions = await sbSelect(
      `studio_sessions?id=eq.${encodeURIComponent(sessionId)}&select=id,host_id,status`,
    ) as Array<{ id: string; host_id: string; status: string }>;
    const session = sessions[0];
    if (!session) return json({ error: 'not_found' }, 404);
    if (session.host_id !== uid) return json({ error: 'not_host' }, 403);
    if (session.status !== 'open') return json({ error: 'session_closed' }, 409);

    // The host cannot remove themselves. Leaving is studio_host_exit, which
    // hands the room to a successor instead of orphaning it.
    if (identity === uid || identity === session.host_id) return json({ error: 'cannot_remove_host' }, 400);

    const isMember = UUID_RE.test(identity);
    if (isMember) {
      // Seat first — see the note at the top on why this order.
      await sbWrite('DELETE',
        `studio_session_members?session_id=eq.${encodeURIComponent(sessionId)}&user_id=eq.${encodeURIComponent(identity)}`);
      // An accepted request left standing would let the listener screen bounce
      // them straight back into the room the moment it polled.
      await sbWrite('PATCH',
        `studio_join_requests?session_id=eq.${encodeURIComponent(sessionId)}&user_id=eq.${encodeURIComponent(identity)}`,
        { status: 'declined' });
    }

    const removed = await removeParticipant(`studio-${sessionId}`, identity);
    // A guest exists ONLY in LiveKit — no row to fall back on — so for them a
    // failed call means nothing happened and the host must be told.
    if (!removed && !isMember) return json({ error: 'livekit_failed' }, 502);

    return json({ ok: true, kind: isMember ? 'member' : 'guest', disconnected: removed });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
