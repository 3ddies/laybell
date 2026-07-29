// Generate the RevenueCat webhook secret, set it on Supabase, and print it once
// so it can be pasted into RevenueCat.
//
//   node scripts/set-revenuecat-secret.mjs
//
// Doing this through a script rather than a shell one-liner avoids the quoting
// and command-substitution problems Git Bash on Windows runs into, and means the
// value is never typed by hand — which is where transposed characters creep in.
//
// The secret authenticates RevenueCat TO our webhook. Anyone holding it could
// post fake purchase events and mint credits, so it belongs in a password
// manager and nowhere else.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const PROJECT_REF = 'wawpaokvtptfmuygjnns';
const secret = randomBytes(24).toString('hex');
const isWin = process.platform === 'win32';

console.log('Setting REVENUECAT_WEBHOOK_SECRET…');
try {
  const args = ['supabase', 'secrets', 'set', `REVENUECAT_WEBHOOK_SECRET=${secret}`,
                '--project-ref', PROJECT_REF];
  execFileSync(
    isWin ? 'cmd.exe' : 'npx',
    isWin ? ['/c', 'npx', ...args] : args,
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  console.log('  ok\n');
} catch (err) {
  console.error('  FAILED.');
  console.error(String(err.stderr || err.stdout || err.message).trim());
  process.exit(1);
}

console.log('────────────────────────────────────────────────────────────');
console.log('In RevenueCat → Integrations → Webhooks → + New:');
console.log('');
console.log('  URL:');
console.log(`    https://${PROJECT_REF}.supabase.co/functions/v1/revenuecat-webhook`);
console.log('');
console.log('  Authorization header (copy the WHOLE line, including "Bearer "):');
console.log(`    Bearer ${secret}`);
console.log('────────────────────────────────────────────────────────────');
console.log('Save this in your password manager. Re-running this script');
console.log('generates a NEW secret and invalidates the old one.');
