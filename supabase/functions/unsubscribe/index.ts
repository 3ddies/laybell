import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// One-click unsubscribe from Laybell's marketing email.
//
// CAN-SPAM requires a working opt-out in every commercial message, honoured
// within 10 business days and functional for at least 30 days after the message
// was sent. Gmail and Yahoo additionally require RFC 8058 one-click for bulk
// senders — a List-Unsubscribe-Post header and a URL that acts on POST with no
// confirmation step — so this answers both GET (a person clicking) and POST (the
// mail client doing it for them).
//
// Deploy:  supabase functions deploy unsubscribe --no-verify-jwt
//
// --no-verify-jwt is REQUIRED: the reader arrives from their email with no
// Supabase session, so with the JWT gateway on they would get a bare 401 and
// this would never run. The signed token IS the credential.
//
// ⚠️ MUST be linked as https://open.laybell.app/functions/v1/unsubscribe, NEVER
// *.supabase.co. On the shared functions domain Supabase force-rewrites HTML to
// text/plain with nosniff, so the reader sees raw markup instead of a page. Same
// trap documented on parent-consent-verify and in lib/appLinks.ts.
//
// SECRET:  supabase secrets set UNSUBSCRIBE_SECRET=<a long random string>
//
// THE TOKEN IS STATELESS ON PURPOSE. An HMAC over the user id needs no table and
// never expires, which is the correct behaviour here: an unsubscribe link in a
// year-old email must still work. A one-time token would expire exactly when
// somebody digs up an old message to get off the list, which is the moment it
// matters most.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const SECRET = Deno.env.get('UNSUBSCRIBE_SECRET');

/** HMAC-SHA256(userId) as lowercase hex — must match lib/unsubscribe.ts. */
async function sign(userId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(SECRET!),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(userId));
  return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time compare, so a wrong token cannot be narrowed by timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const page = (title: string, msg: string, ok: boolean) => new Response(
  `<!doctype html><meta charset="utf-8">`
  + `<meta name="viewport" content="width=device-width,initial-scale=1">`
  + `<title>${title} · Laybell</title>`
  + `<style>`
  + `:root{--bg:#faf9f7;--card:#fff;--ink:#1b1b1f;--muted:#5f5f6a;--brand:#E8401C;--ok:#12855C;--line:rgba(0,0,0,.08)}`
  + `@media(prefers-color-scheme:dark){:root{--bg:#121214;--card:#1c1c20;--ink:#f4f4f6;--muted:#a2a2ad;--ok:#3DD68C;--line:rgba(255,255,255,.10)}}`
  + `*{box-sizing:border-box}`
  + `body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;`
  + `background:var(--bg);color:var(--ink);`
  + `font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}`
  + `.card{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:18px;`
  + `padding:36px 28px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.06),0 12px 32px rgba(0,0,0,.06)}`
  + `.mark{font-weight:800;font-size:19px;letter-spacing:-.02em;color:var(--brand);margin:0 0 22px}`
  + `h1{font-size:21px;line-height:1.25;margin:0 0 10px;letter-spacing:-.01em}`
  + `p{font-size:15px;line-height:1.55;color:var(--muted);margin:0 0 8px}`
  + `.addr{font-size:12px;color:var(--muted);margin-top:22px;line-height:1.5}`
  + `</style>`
  + `<div class="card"><p class="mark">Laybell</p>`
  + `<h1>${title}</h1><p>${msg}</p>`
  // CAN-SPAM wants the sender's physical address in the message; repeating it on
  // the landing page costs nothing and answers "who was that from" for someone
  // who has arrived here confused.
  + `<p class="addr">Laybell LLC · 28 Rivers Edge Ter, Indian Head, MD 20640</p></div>`,
  { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
);

serve(async (req) => {
  if (!SECRET || !SUPABASE_URL || !SERVICE_KEY) {
    return page('Not available', 'This link is not set up yet. Email support@laybell.app and we will remove you by hand.', false);
  }

  const url = new URL(req.url);
  const uid = (url.searchParams.get('u') ?? '').trim();
  const tok = (url.searchParams.get('t') ?? '').trim().toLowerCase();
  if (!uid || !tok) {
    return page('Link incomplete', 'This unsubscribe link is missing part of its address. Email support@laybell.app and we will remove you by hand.', false);
  }

  let expected: string;
  try { expected = await sign(uid); } catch {
    return page('Something went wrong', 'Please try again, or email support@laybell.app.', false);
  }
  if (!safeEqual(tok, expected)) {
    return page('Link not recognised', 'This unsubscribe link is not valid. Email support@laybell.app and we will remove you by hand.', false);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { error } = await admin
    .from('profiles')
    .update({ marketing_opt_in: false, marketing_opt_in_at: new Date().toISOString() })
    .eq('id', uid);

  if (error) {
    return page('Something went wrong', 'We could not update your preferences just now. Please try again, or email support@laybell.app.', false);
  }

  // RFC 8058: the mail client POSTs and expects a plain 200, no page.
  if (req.method === 'POST') return new Response('OK', { status: 200 });

  return page(
    'You are unsubscribed',
    'You will not get any more marketing email from Laybell. Account and security messages — password resets, verification codes — still come, because those are not marketing. You can turn marketing email back on any time in Settings.',
    true,
  );
});
