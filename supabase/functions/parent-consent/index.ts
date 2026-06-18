import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Emails a parent/guardian a one-time link to confirm consent for a 13–17 user.
// The app calls this after a minor attests to consent during onboarding.
//
// Deploy:  supabase functions deploy parent-consent
// Secrets (supabase secrets set ...):
//   RESEND_API_KEY      your Resend (or other provider) API key
//   CONSENT_FROM_EMAIL  e.g. "Laybell <privacy@laybell.app>" (verified sender)
//   CONSENT_VERIFY_URL  the deployed parent-consent-verify function URL, e.g.
//                       https://<project-ref>.functions.supabase.co/parent-consent-verify
// Until those are set it records the token and returns {ok:false, reason} without
// sending — the in-app attestation already gates the account, so nothing breaks.
serve(async (req) => {
  try {
    const { userId, parentEmail } = await req.json();
    if (!userId || !parentEmail) return new Response('Bad request', { status: 400 });

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const token = crypto.randomUUID();
    const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    await supabase.from('parent_consent_tokens').insert({
      token, user_id: userId, parent_email: parentEmail, expires_at: expires,
    });

    const apiKey = Deno.env.get('RESEND_API_KEY');
    const from = Deno.env.get('CONSENT_FROM_EMAIL');
    const verifyBase = Deno.env.get('CONSENT_VERIFY_URL');
    if (!apiKey || !from || !verifyBase) {
      return new Response(JSON.stringify({ ok: false, reason: 'email-not-configured' }), {
        headers: { 'Content-Type': 'application/json' }, status: 200,
      });
    }

    const link = `${verifyBase}?token=${token}`;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: parentEmail,
        subject: "Confirm your child's Laybell account",
        html:
          `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1b1b1f">` +
          `<h2 style="color:#E8401C">Laybell</h2>` +
          `<p>A teen using your email said you agreed to let them use <b>Laybell</b>, ` +
          `a social music app (minimum age 13).</p>` +
          `<p>If that's correct, please confirm:</p>` +
          `<p><a href="${link}" style="background:#E8401C;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Confirm consent</a></p>` +
          `<p style="color:#666;font-size:13px">If you didn't expect this, ignore this email and the account will stay restricted. ` +
          `Questions: privacy@laybell.app</p></div>`,
      }),
    });

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' }, status: 200,
    });
  } catch (err) {
    return new Response(String(err), { status: 500 });
  }
});
