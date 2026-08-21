import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Landing page the parent/guardian reaches from the confirmation email. Marks
// the minor's account as parent-consent-verified and shows a friendly page.
//
// Deploy:  supabase functions deploy parent-consent-verify --no-verify-jwt
//
// --no-verify-jwt is REQUIRED. The guardian arrives from an email link with no
// Supabase session, so with the JWT gateway on they get a bare 401 and this
// function never runs or logs. The one-time `token` query param is the
// credential, and it is validated below (exists, unconsumed, unexpired).
//
// Set this function's URL as CONSENT_VERIFY_URL for the parent-consent function.
// ⚠️ THIS PAGE MUST BE REACHED VIA open.laybell.app, NOT *.supabase.co.
// On the SHARED functions domain Supabase force-rewrites HTML to
// `Content-Type: text/plain` with `nosniff` (anti-phishing), so the browser
// prints the markup as text and a parent sees raw `<!doctype html>…` instead of a
// page. Confirmed on device 2026-08-21. The custom domain is not sanitised.
// CONSENT_VERIFY_URL must therefore be
//   https://open.laybell.app/functions/v1/parent-consent-verify
// This is the same trap that silently broke shared post cards — see lib/appLinks.ts.
serve(async (req) => {
  const page = (title: string, msg: string, ok: boolean) => new Response(
    `<!doctype html><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${title} · Laybell</title>` +
    `<style>` +
    `:root{--bg:#faf9f7;--card:#fff;--ink:#1b1b1f;--muted:#5f5f6a;--brand:#E8401C;--ok:#12855C;--line:rgba(0,0,0,.08)}` +
    `@media(prefers-color-scheme:dark){:root{--bg:#121214;--card:#1c1c20;--ink:#f4f4f6;--muted:#a2a2ad;--ok:#3DD68C;--line:rgba(255,255,255,.10)}}` +
    `*{box-sizing:border-box}` +
    `body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;` +
    `background:var(--bg);color:var(--ink);` +
    `font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}` +
    `.card{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:18px;` +
    `padding:36px 28px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.06),0 12px 32px rgba(0,0,0,.06)}` +
    `.mark{font-weight:800;font-size:19px;letter-spacing:-.02em;color:var(--brand);margin:0 0 22px}` +
    `.icon{width:56px;height:56px;margin:0 auto 18px;display:block}` +
    `h1{font-size:21px;line-height:1.25;margin:0 0 10px;letter-spacing:-.01em}` +
    `p{font-size:15px;line-height:1.55;color:var(--muted);margin:0}` +
    `.foot{margin-top:24px;padding-top:18px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}` +
    `a{color:var(--brand);text-decoration:none}` +
    `</style>` +
    `<body><main class="card">` +
    `<p class="mark">Laybell</p>` +
    (ok
      ? `<svg class="icon" viewBox="0 0 52 52" fill="none" aria-hidden="true">` +
        `<circle cx="26" cy="26" r="24" stroke="var(--ok)" stroke-width="3"/>` +
        `<path d="M15 27.5 22.5 35 37 19" stroke="var(--ok)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      : `<svg class="icon" viewBox="0 0 52 52" fill="none" aria-hidden="true">` +
        `<circle cx="26" cy="26" r="24" stroke="var(--muted)" stroke-width="3"/>` +
        `<path d="M26 15v16" stroke="var(--muted)" stroke-width="4" stroke-linecap="round"/>` +
        `<circle cx="26" cy="38" r="2.5" fill="var(--muted)"/></svg>`) +
    `<h1>${title}</h1><p>${msg}</p>` +
    `<p class="foot">Questions? <a href="mailto:privacy@laybell.app">privacy@laybell.app</a></p>` +
    `</main></body>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 200 },
  );

  const token = new URL(req.url).searchParams.get('token');
  if (!token) return page('Link not recognised', 'This confirmation link is not valid. Please open the link exactly as it appears in the email.', false);

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: row } = await supabase
      .from('parent_consent_tokens').select('*').eq('token', token).single();
    // Split deliberately. Folding "no such token" into "already used" told a parent
    // the account was active when nothing had been confirmed — a false reassurance
    // on a consent flow, which is the one place it must never happen.
    if (!row) return page('Link not recognised', 'We could not find this confirmation link. Please open the link exactly as it appears in the email — nothing has been confirmed yet.', false);
    if (row.consumed) return page('Already confirmed', 'This link has already been used. If you have confirmed once, nothing further is needed — the account is active.', false);
    if (new Date(row.expires_at) < new Date()) {
      return page('Link expired', 'For safety these links do not last forever. Ask the account holder to resend the confirmation from the app, and we will email you a fresh link.', false);
    }

    await supabase.from('profiles').update({
      parent_consent_verified: true,
      parent_consent_method: 'email_verified',
      minor_consent_at: new Date().toISOString(),
    }).eq('id', row.user_id);
    await supabase.from('parent_consent_tokens').update({ consumed: true }).eq('token', token);

    return page('Consent confirmed', 'Thank you. You have confirmed permission for this teen to use Laybell, and their account is now fully active. You can close this page.', true);
  } catch {
    return page('Something went wrong', 'We could not confirm this just now. Please try the link again in a few minutes.', false);
  }
});
