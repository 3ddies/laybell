// Stream-sweep helper: rotate the secret, then run a DRY RUN.
//
//   node scripts/stream-sweep.mjs            → rotate secret + dry run (safe)
//   node scripts/stream-sweep.mjs --apply    → rotate secret + ACTUALLY DELETE
//
// Why this exists: setting the secret by hand means pasting a long random string
// into a shell, which invites two mistakes — dropping the space before a flag, and
// leaking the value into a chat log or screen share. Here the secret is generated,
// used, and printed exactly once, and never has to be copied anywhere in between.
//
// Rotating on every run is deliberate. The secret's only job is gating this
// script, so a fresh one each time costs nothing and means a leaked value is
// worthless the moment you run it again.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const PROJECT_REF = 'wawpaokvtptfmuygjnns';
const APPLY = process.argv.includes('--apply');

const secret = randomBytes(32).toString('hex');

console.log('Setting STREAM_SWEEP_SECRET…');
const isWin = process.platform === 'win32';
try {
  // Windows can't spawn npx directly: since CVE-2024-27980 Node refuses to launch
  // .cmd/.bat files and throws EINVAL. `shell: true` fixes it but concatenates
  // arguments without escaping — Node itself now warns about that (DEP0190).
  // Invoking cmd.exe explicitly gets the same result while letting Node escape
  // each argument properly, so no unescaped string is ever handed to a shell.
  const args = ['supabase', 'secrets', 'set', `STREAM_SWEEP_SECRET=${secret}`,
                '--project-ref', PROJECT_REF];
  execFileSync(
    isWin ? 'cmd.exe' : 'npx',
    isWin ? ['/c', 'npx', ...args] : args,
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  console.log('  ok\n');
} catch (err) {
  console.error('  FAILED to set the secret.');
  console.error(String(err.stderr || err.stdout || err.message).trim());
  process.exit(1);
}

// Edge Function secrets propagate asynchronously; calling immediately can hit the
// previous value and 401.
console.log('Waiting 5s for the secret to propagate…\n');
await new Promise((r) => setTimeout(r, 5000));

console.log(APPLY ? '⚠️  RUNNING FOR REAL — this DELETES media\n' : 'Dry run — nothing will be deleted\n');

const res = await fetch(`https://${PROJECT_REF}.supabase.co/functions/v1/stream-sweep`, {
  method: 'POST',
  headers: { 'x-sweep-secret': secret, 'content-type': 'application/json' },
  body: JSON.stringify({ apply: APPLY, minAgeHours: 24 }),
});

const text = await res.text();
console.log(`HTTP ${res.status}`);
try {
  const j = JSON.parse(text);
  console.log(JSON.stringify(j, null, 2));
  if (j.error === 'stream_not_configured') {
    console.log('\n→ CF_ACCOUNT_ID / CF_STREAM_TOKEN are not set on this project.');
  } else if (j.error === 'sweep_not_configured') {
    console.log('\n→ The secret did not take. Re-run this script.');
  } else if (j.dryRun) {
    console.log(`\n→ ${j.orphansFound} orphan(s), ${(j.orphanBytes / 1e9).toFixed(2)} GB.`);
    console.log('→ Safe to paste this output; it contains no secret.');
    if (j.orphansFound > 0) console.log('→ To delete them: node scripts/stream-sweep.mjs --apply');
  }
} catch {
  console.log(text);
}

console.log('\n────────────────────────────────────────────────────────');
console.log('New STREAM_SWEEP_SECRET (save it, or just re-run this script later):');
console.log('  ' + secret);
console.log('Do NOT paste this line anywhere. The JSON above is safe to share.');
console.log('────────────────────────────────────────────────────────');
