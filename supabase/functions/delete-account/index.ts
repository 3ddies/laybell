import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Permanently deletes the CALLER's own account — the one thing the app's anon key
// cannot do (deleting an auth user needs the service-role / Admin API).
//
// NOTE (2026-06-19): the app no longer calls this on "Delete now" — deletion is now
// DEFERRED 48 hours and completed by supabase/sql/account_deletion_sweep.sql. This
// function is kept as an OPTIONAL on-demand / admin "force delete" utility (still
// hold-aware). Deploying it is no longer required for normal account deletion.
//
// Hold-aware (see supabase/sql/moderation_preservation.sql): if the account or any
// of its posts is under a legal_hold, we do NOT delete — we BAN the auth user (so
// they can't log in) and keep the flags, preserving the content/evidence until the
// hold is cleared by a moderator/cleanup job. Otherwise we hard-delete the auth
// user, which cascades their rows (FKs) and fires the storage-cleanup trigger to
// purge their media. Open reports never block deletion: reports + their content
// snapshots survive deletion on their own (ON DELETE SET NULL), so evidence is
// kept either way.
//
// Deploy: supabase functions deploy delete-account
// (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.)

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

serve(async (req) => {
  try {
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
    if (!jwt) return json({ status: 'error', message: 'missing token' }, 401);

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Identify the caller from their own JWT — a user can only delete themselves.
    const { data: { user }, error: uErr } = await admin.auth.getUser(jwt);
    if (uErr || !user) return json({ status: 'error', message: 'unauthorized' }, 401);
    const uid = user.id;

    // Legal hold = the deliberate "do not delete" lever for an active investigation
    // or preservation request. (Reports alone do not block — they survive deletion.)
    const [{ data: heldPosts }, { data: prof }] = await Promise.all([
      admin.from('posts').select('id').eq('user_id', uid).eq('legal_hold', true).limit(1),
      admin.from('profiles').select('legal_hold').eq('id', uid).maybeSingle(),
    ]);
    const onHold = (heldPosts?.length ?? 0) > 0 || (prof as any)?.legal_hold === true;

    if (onHold) {
      // Preserve: block login by banning the auth user, keep the account flagged.
      await admin.auth.admin.updateUserById(uid, { ban_duration: '876000h' }); // ~100y
      await admin.from('profiles').update({
        hidden: true, delete_immediately: true, delete_requested_at: new Date().toISOString(),
      }).eq('id', uid);
      return json({ status: 'preserved', reason: 'legal_hold' });
    }

    // No hold — actually delete the auth user. Cascades their data; the
    // storage-cleanup trigger purges their media buckets.
    const { error: dErr } = await admin.auth.admin.deleteUser(uid);
    if (dErr) return json({ status: 'error', message: dErr.message }, 500);
    return json({ status: 'deleted' });
  } catch (err) {
    return json({ status: 'error', message: String(err) }, 500);
  }
});
