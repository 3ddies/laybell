import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// Fill in the identifiers that only exist once the app is actually registered
// with Apple and Google.
//
// These live in four files that have no reason to know about each other — a TS
// module, a static HTML page, and two well-known files served at the domain
// root. Setting them by hand means four chances to miss one, and a missed one
// fails silently: the store link 404s, or universal links quietly fall back to
// opening the website instead of the app. So: one command, all four, plus a
// --check that tells you what's still unset.
//
//   node scripts/set-store-ids.mjs --check
//   node scripts/set-store-ids.mjs --app-store-id 6478123456
//   node scripts/set-store-ids.mjs --team-id A1B2C3D4E5
//   node scripts/set-store-ids.mjs --android-sha256 AB:CD:EF:...
//
// Where to find each one:
//   app-store-id   App Store Connect -> your app -> App Information -> Apple ID
//                  (the numeric one, not the bundle ID). Exists as soon as the
//                  app record is created — you do NOT have to be live first.
//   team-id        developer.apple.com -> Membership. Ten characters.
//   android-sha256 Play Console -> Test and release -> App integrity -> App
//                  signing -> "SHA-256 certificate fingerprint".
//                  IMPORTANT: use the APP SIGNING key, not the upload key. With
//                  Play App Signing, Google re-signs your build, so the upload
//                  fingerprint is not what verifies your links, and using it is
//                  the single most common reason Android app links silently
//                  fail to verify.

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const TARGETS = [
  {
    id: 'app-store-id',
    label: 'Apple App Store numeric ID',
    placeholder: 'id000000000',
    validate: (v) => /^\d{9,12}$/.test(v) || 'expected 9-12 digits, e.g. 6478123456',
    format: (v) => `id${v}`,
    files: ['lib/appLinks.ts', 'web/open.html'],
  },
  {
    id: 'team-id',
    label: 'Apple Team ID',
    placeholder: 'TEAMID',
    validate: (v) => /^[A-Z0-9]{10}$/.test(v) || 'expected 10 uppercase alphanumerics, e.g. A1B2C3D4E5',
    format: (v) => v,
    files: ['web/.well-known/apple-app-site-association'],
  },
  {
    id: 'android-sha256',
    label: 'Android app-signing SHA-256 fingerprint',
    placeholder: 'ANDROID_SHA256_FINGERPRINT',
    validate: (v) =>
      /^([A-F0-9]{2}:){31}[A-F0-9]{2}$/i.test(v) ||
      'expected 32 colon-separated hex pairs (copy it verbatim from Play Console)',
    format: (v) => v.toUpperCase(),
    files: ['web/.well-known/assetlinks.json'],
  },
];

function read(rel) {
  const p = `${ROOT}/${rel}`;
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

const args = process.argv.slice(2);
const check = args.includes('--check');

if (check || args.length === 0) {
  let outstanding = 0;
  for (const t of TARGETS) {
    const pending = t.files.filter((f) => (read(f) ?? '').includes(t.placeholder));
    if (pending.length) {
      outstanding++;
      console.log(`UNSET  ${t.label}`);
      for (const f of pending) console.log(`         ${f}`);
      console.log(`         set with: node scripts/set-store-ids.mjs --${t.id} <value>`);
    } else {
      console.log(`ok     ${t.label}`);
    }
  }
  console.log(
    outstanding
      ? `\n${outstanding} identifier(s) still unset — deep links and store links will not work until they are.`
      : '\nAll store identifiers are set.',
  );
  process.exit(outstanding ? 1 : 0);
}

let wrote = 0;
for (const t of TARGETS) {
  const i = args.indexOf(`--${t.id}`);
  if (i === -1) continue;
  const raw = (args[i + 1] ?? '').trim();
  if (!raw || raw.startsWith('--')) {
    console.error(`--${t.id} needs a value`);
    process.exit(1);
  }
  const ok = t.validate(raw);
  if (ok !== true) {
    console.error(`--${t.id}: ${ok}`);
    process.exit(1);
  }
  const value = t.format(raw);

  for (const f of t.files) {
    const src = read(f);
    if (src === null) { console.error(`missing file: ${f}`); process.exit(1); }
    if (!src.includes(t.placeholder)) {
      console.log(`skip   ${f} (no ${t.placeholder} left — already set?)`);
      continue;
    }
    const out = src.split(t.placeholder).join(value);
    writeFileSync(`${ROOT}/${f}`, out, 'utf8');
    console.log(`wrote  ${f}`);
    wrote++;
  }
}

if (!wrote) {
  console.log('nothing to do — pass --check to see what is still unset');
} else {
  console.log(`\n${wrote} file(s) updated. Commit them, then re-run with --check to confirm.`);
}
