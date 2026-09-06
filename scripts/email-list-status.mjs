#!/usr/bin/env node
// Where one account stands on Laybell's email list, plus its unsubscribe link.
//
//   node scripts/email-list-status.mjs ehall1@ncat.edu
//
// Reads through the Supabase CLI rather than holding a service key, so it needs
// no secret of its own beyond UNSUBSCRIBE_SECRET (and that only to print the
// link — the status works without it).
//
// The link it prints is the REAL one. Clicking it unsubscribes that account for
// real, which is the point: the only way to know the endpoint works is to use
// the endpoint.
import { execSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';

const email = (process.argv[2] || '').trim().toLowerCase();
if (!email) {
  console.error('usage: node scripts/email-list-status.mjs <email>');
  process.exit(1);
}

// Written to a file because `supabase db query` takes -f, not stdin. Quoted with
// JSON.stringify so an address with an apostrophe cannot break out of the SQL.
const sqlPath = 'supabase/sql/_DEV_email_status.sql';
const lit = `'${email.replace(/'/g, "''")}'`;
writeFileSync(sqlPath, `
select
  u.id,
  u.email,
  p.username,
  p.marketing_opt_in                                   as on_the_list,
  p.marketing_opt_in_at                                as chose_at,
  u.email_confirmed_at is not null                     as email_confirmed,
  coalesce(p.is_minor, false)                          as is_minor,
  exists (select 1 from public.marketing_email_list m where m.id = u.id) as mailable,
  (select count(*) from public.marketing_email_list)   as list_size
  from auth.users u
  left join public.profiles p on p.id = u.id
 where lower(u.email) = ${lit};
`, 'utf8');

let out = '';
try {
  // execSync with ONE fixed string, not execFileSync+shell:true — the latter
  // concatenates argv into a shell line without escaping it, which Node now warns
  // about. Nothing user-supplied reaches this command; the email goes into the
  // SQL file, escaped, and never onto the command line.
  out = execSync(`npx supabase db query --linked -f ${sqlPath}`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
} finally {
  try { unlinkSync(sqlPath); } catch {}
}

const rows = (() => { try { return JSON.parse(out.slice(out.indexOf('{'))).rows ?? []; } catch { return []; } })();
if (rows.length === 0) {
  console.log(`No account for ${email} yet.`);
  process.exit(0);
}

const r = rows[0];
const yn = (v) => (v ? 'yes' : 'no');
console.log('');
console.log(`  account          ${r.username ?? '(no profile yet)'}  ${r.email}`);
console.log(`  on the list      ${yn(r.on_the_list)}`);
console.log(`  chose explicitly ${r.chose_at ? r.chose_at : 'no — took the default'}`);
console.log(`  email confirmed  ${yn(r.email_confirmed)}`);
console.log(`  minor            ${yn(r.is_minor)}`);
console.log(`  MAILABLE         ${yn(r.mailable)}`);
console.log(`  list size        ${r.list_size}`);

// `mailable` is the view's own verdict, so a mismatch here means one of the
// other rules excluded them — an unconfirmed address, a hidden account.
if (r.on_the_list && !r.mailable) {
  console.log('');
  console.log('  NOTE: opted in but NOT mailable — the list also requires a confirmed');
  console.log('        email and a non-hidden account.');
}

const secret = process.env.UNSUBSCRIBE_SECRET;
console.log('');
if (secret) {
  const sig = createHmac('sha256', secret).update(r.id).digest('hex');
  console.log('  unsubscribe link (clicking it really unsubscribes):');
  console.log(`  https://open.laybell.app/functions/v1/unsubscribe?u=${r.id}&t=${sig}`);
} else {
  console.log('  Set UNSUBSCRIBE_SECRET to have the unsubscribe link printed too.');
}
console.log('');
