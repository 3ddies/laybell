import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Landing page the parent/guardian reaches from the confirmation email. Marks
// the minor's account as parent-consent-verified and shows a friendly page.
//
// Deploy:  supabase functions deploy parent-consent-verify
// Set this function's URL as CONSENT_VERIFY_URL for the parent-consent function.
serve(async (req) => {
  const page = (msg: string) => new Response(
    `<!doctype html><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#faf9f7;color:#1b1b1f;text-align:center;padding:48px 20px">` +
    `<h2 style="color:#E8401C">Laybell</h2><p style="font-size:16px;max-width:420px;margin:0 auto">${msg}</p></body>`,
    { headers: { 'Content-Type': 'text/html' }, status: 200 },
  );

  const token = new URL(req.url).searchParams.get('token');
  if (!token) return page('This confirmation link is invalid.');

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: row } = await supabase
      .from('parent_consent_tokens').select('*').eq('token', token).single();
    if (!row || row.consumed) return page('This link is invalid or has already been used.');
    if (new Date(row.expires_at) < new Date()) {
      return page('This link has expired. Ask the teen to resend the confirmation from the app.');
    }

    await supabase.from('profiles').update({
      parent_consent_verified: true,
      parent_consent_method: 'email_verified',
      minor_consent_at: new Date().toISOString(),
    }).eq('id', row.user_id);
    await supabase.from('parent_consent_tokens').update({ consumed: true }).eq('token', token);

    return page('Thank you — consent confirmed. The account is now fully active. You can close this page.');
  } catch {
    return page('Something went wrong. Please try again later.');
  }
});
