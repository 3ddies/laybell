// Send a REAL signup confirmation email, to verify custom SMTP end to end.
//
//   node scripts/test-signup-email.mjs you@gmail.com
//
// This exercises the exact path a new user takes: Supabase auth signup → the
// "Confirm signup" template → your Resend SMTP → their inbox. Testing any
// narrower (a provider's own "send test" button, say) proves the mail server
// works but not that YOUR template and sender are right — which is where the
// 6-digit code actually comes from.
//
// ⚠️ This creates a real auth user. Use an address you control, and delete the
// user afterwards in Supabase → Authentication → Users.
//
// The anon key is read from lib/supabase.ts rather than passed in. It is public
// by design (it ships in the app bundle and is constrained by RLS), but there is
// no reason to paste it around.

import { readFileSync } from 'node:fs';

const email = process.argv[2];
if (!email || !email.includes('@')) {
  console.error('Usage: node scripts/test-signup-email.mjs you@example.com');
  process.exit(1);
}

const src = readFileSync('lib/supabase.ts', 'utf8');
const url = (src.match(/supabaseUrl\s*=\s*'([^']+)'/) || [])[1];
const key = (src.match(/supabaseAnonKey\s*=\s*'([^']+)'/) || [])[1];
if (!url || !key) {
  console.error('Could not read supabaseUrl / supabaseAnonKey from lib/supabase.ts');
  process.exit(1);
}

// A throwaway password. The point is the email, not the account.
const password = 'Test-' + Math.random().toString(36).slice(2, 10) + '!aA1';

console.log(`Signing up ${email} …`);
const res = await fetch(`${url}/auth/v1/signup`, {
  method: 'POST',
  headers: { apikey: key, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});

const body = await res.json().catch(() => ({}));
console.log(`HTTP ${res.status}\n`);

if (res.ok) {
  const identities = body?.identities;
  if (Array.isArray(identities) && identities.length === 0) {
    console.log('This address already has an account, so no email was sent.');
    console.log('Supabase hides that fact from clients on purpose (it stops anyone');
    console.log('probing which addresses are registered). Try a different address,');
    console.log('or delete the user first in Authentication → Users.');
  } else {
    console.log('Signup accepted. Supabase has handed the email to your SMTP provider.');
    console.log('\nNow check:');
    console.log('  1. Your INBOX (and spam) for a mail with a 6-digit code');
    console.log('  2. Subject should read: "Your Laybell code: <6 digits>"');
    console.log('  3. Sender should be no-reply@laybell.app — NOT supabase.io');
    console.log('  4. Resend → Logs should show it as delivered');
    console.log('\nDelete the test user afterwards: Authentication → Users.');
  }
} else {
  console.log(JSON.stringify(body, null, 2));
  const msg = String(body?.msg || body?.message || body?.error_description || '');
  if (/smtp|mail|send/i.test(msg)) {
    console.log('\n→ SMTP rejected it. Check Supabase → Auth → SMTP Settings:');
    console.log('  host smtp.resend.com · port 465 · username literally "resend"');
    console.log('  password = the re_… API key · sender no-reply@laybell.app');
  } else if (/rate|limit/i.test(msg)) {
    console.log('\n→ Rate limited. Raise it in Supabase → Auth → Rate Limits.');
  }
}
