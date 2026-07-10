import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─────────────────────────────────────────────────────────────────────────────
// admin-actions — the ONE privileged endpoint for the moderation console. It does
// only the things the SECURITY DEFINER admin RPCs cannot: the auth-plane operations
// that need the Supabase Admin API (login-ban / unban / hard-delete) and reading
// auth.users (email / last sign-in / ban status).
//
// Everything the RPCs CAN do (queue, resolve, warn, suspend, shadow-ban, hide,
// legal-hold, escalate, blocklist) stays in Postgres — see admin_console_rpcs.sql.
//
// GATE (defence in depth):
//   1. The caller is identified from their OWN JWT via admin.auth.getUser(jwt)
//      (verified — NOT an unverified base64 decode).
//   2. They must be an OWNER in public.laybell_admins (disabled_at is null). Every
//      action here is owner-only because they are irreversible / auth-plane.
//   3. Every action writes an append-only admin_audit_log row.
//
// The SERVICE ROLE key never leaves this function — do NOT import it into the app
// or the web console bundle.
//
// Deploy:  supabase functions deploy admin-actions
//   (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
//   Keep the default verify_jwt = true so only signed-in callers can reach it; the
//   owner-role check below is the real authorization.
// ─────────────────────────────────────────────────────────────────────────────

const BAN_FOREVER = '876000h'; // ~100 years, matches delete-account/index.ts

const CORS = {
  'Access-Control-Allow-Origin': '*', // auth is by Bearer JWT + owner-role check, not origin
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ status: 'error', message: 'method not allowed' }, 405);

  try {
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
    if (!jwt) return json({ status: 'error', message: 'missing token' }, 401);

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // 1) Who is calling? (verified)
    const { data: { user }, error: uErr } = await admin.auth.getUser(jwt);
    if (uErr || !user) return json({ status: 'error', message: 'unauthorized' }, 401);

    // 2) Are they an OWNER? (single source of truth: laybell_admins)
    const { data: adminRow } = await admin
      .from('laybell_admins')
      .select('role, disabled_at')
      .eq('user_id', user.id)
      .maybeSingle();
    const isOwner = adminRow && adminRow.disabled_at === null && adminRow.role === 'owner';
    if (!isOwner) return json({ status: 'error', message: 'owner_only' }, 403);

    const body = await req.json().catch(() => ({}));
    const action: string = body?.action ?? '';
    const targetId: string | undefined = body?.user_id;
    const reason: string | null = body?.reason ?? null;

    const writeAudit = (act: string, detail: Record<string, unknown> = {}) =>
      admin.from('admin_audit_log').insert({
        actor_id: user.id,
        actor_role: 'owner',
        action: act,
        target_type: 'user',
        target_id: targetId ?? null,
        target_user_id: targetId ?? null,
        reason,
        detail,
      });

    // ── auth_info: read the auth-plane fields the RPCs can't expose ────────────
    if (action === 'auth_info') {
      if (!targetId) return json({ status: 'error', message: 'user_id required' }, 400);
      const { data, error } = await admin.auth.admin.getUserById(targetId);
      if (error) return json({ status: 'error', message: error.message }, 500);
      const u = data.user;
      await writeAudit('view_auth_info');
      return json({
        status: 'ok',
        auth: {
          email: u?.email ?? null,
          phone: u?.phone ?? null,
          created_at: u?.created_at ?? null,
          last_sign_in_at: u?.last_sign_in_at ?? null,
          banned_until: (u as { banned_until?: string })?.banned_until ?? null,
        },
      });
    }

    // ── ban: block login without deleting anything ────────────────────────────
    if (action === 'ban') {
      if (!targetId) return json({ status: 'error', message: 'user_id required' }, 400);
      const { error } = await admin.auth.admin.updateUserById(targetId, { ban_duration: BAN_FOREVER });
      if (error) return json({ status: 'error', message: error.message }, 500);
      // The sanction row is what drives the RLS enforcement (hide content + block
      // posting). The GoTrue ban only stops token REFRESH — a live access token lasts
      // ~1h — so if this write fails the abuser keeps posting while we'd report success.
      // Surface the failure instead of swallowing it.
      const { error: sErr } = await admin.from('user_sanctions').upsert(
        { user_id: targetId, state: 'banned', reason, actor_id: user.id, auth_ban_synced: true, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' },
      );
      if (sErr) return json({ status: 'error', message: `auth banned but sanction write failed: ${sErr.message}` }, 500);
      await writeAudit('ban');
      return json({ status: 'banned' });
    }

    // ── unban: restore login ──────────────────────────────────────────────────
    if (action === 'unban') {
      if (!targetId) return json({ status: 'error', message: 'user_id required' }, 400);
      const { error } = await admin.auth.admin.updateUserById(targetId, { ban_duration: 'none' });
      if (error) return json({ status: 'error', message: error.message }, 500);
      const { error: sErr } = await admin.from('user_sanctions').upsert(
        { user_id: targetId, state: 'active', suspended_until: null, reason, actor_id: user.id, auth_ban_synced: false, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' },
      );
      if (sErr) return json({ status: 'error', message: `auth unbanned but sanction write failed: ${sErr.message}` }, 500);
      await writeAudit('unban');
      return json({ status: 'unbanned' });
    }

    // ── hard_delete: permanent, cascading, hold-aware. Requires confirm:true ───
    if (action === 'hard_delete') {
      if (!targetId) return json({ status: 'error', message: 'user_id required' }, 400);
      if (body?.confirm !== true) return json({ status: 'error', message: 'confirm required' }, 400);

      // Never destroy evidence under a legal hold — refuse and tell the caller to
      // ban (or release the hold) instead. Mirrors delete-account/index.ts.
      const [{ data: heldPosts }, { data: prof }] = await Promise.all([
        admin.from('posts').select('id').eq('user_id', targetId).eq('legal_hold', true).limit(1),
        admin.from('profiles').select('legal_hold').eq('id', targetId).maybeSingle(),
      ]);
      const onHold = (heldPosts?.length ?? 0) > 0 || (prof as { legal_hold?: boolean } | null)?.legal_hold === true;
      if (onHold) return json({ status: 'error', message: 'on_legal_hold' }, 409);

      // Audit BEFORE the delete. admin_audit_log.target_user_id is a plain uuid
      // (no FK) so it survives the cascade as the permanent record of who was deleted.
      await writeAudit('hard_delete');
      const { error } = await admin.auth.admin.deleteUser(targetId);
      if (error) return json({ status: 'error', message: error.message }, 500);
      return json({ status: 'deleted' });
    }

    return json({ status: 'error', message: `unknown action: ${action}` }, 400);
  } catch (err) {
    return json({ status: 'error', message: String(err) }, 500);
  }
});
