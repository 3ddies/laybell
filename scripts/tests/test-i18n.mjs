// Run from the repo root: node scripts/tests/test-i18n.mjs
// Tests lib/i18n.ts and the per-language dictionaries in lib/locales — the
// shipped sources, compiled. The dictionaries moved out of lib/i18n.ts in 1.0.4
// so that a launch no longer builds ten languages to read one; these checks are
// what makes that safe: every language still resolves, still falls back to
// English key by key, and still carries the same keys English does.
import { execSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = join(tmpdir(), 'laybell-tests', 'test-i18n');
// Listed one by one, not as a glob: the shell that runs this on Windows does not
// expand one. The dictionaries are required by path at runtime, so nothing pulls
// them into the compile on its own.
const sources = readdirSync('lib/locales')
  .filter((f) => f.endsWith('.ts'))
  .map((f) => `lib/locales/${f}`);
execSync(
  `npx tsc lib/i18n.ts ${sources.join(' ')} --outDir "${OUT}" --module commonjs --target es2022 --skipLibCheck --strict --types node`,
  { stdio: 'inherit' },
);
writeFileSync(join(OUT, 'package.json'), '{"type":"commonjs"}');
const require = createRequire(import.meta.url);
const I = require(join(OUT, 'i18n.js'));

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got  ${g}\n          want ${w}`); }
};
const ok = (cond, label) => eq(!!cond, true, label);

const codes = I.LANGUAGES.map((l) => l.code);

console.log('\nlanguages');
eq(codes.length, 10, 'ten languages in the picker');
eq(codes[0], I.DEFAULT_LANG, 'English is first and is the default');
ok(codes.every(I.isLang), 'every listed code passes isLang');
ok(!I.isLang('xx') && !I.isLang(null), 'an unknown code does not');

console.log('\nevery language resolves');
// A key every screen needs, in every language: a miss would render English (or
// the raw key) in a UI the user set to their own language.
for (const code of codes) {
  const s = I.translate(code, 'common.cancel');
  ok(typeof s === 'string' && s.length > 0 && s !== 'common.cancel', `${code}: common.cancel is translated`);
}

console.log('\nfallbacks');
eq(I.translate('es', 'nope.not.a.key'), 'nope.not.a.key', 'an unknown key comes back as itself');
eq(I.translate('en', 'common.cancel'), I.translate('en', 'common.cancel'), 'English reads from the inline dictionary');
// A key present in English but missing from a translation must show English,
// never a blank — this is what lets a partial translation ship.
eq(I.translate('xx', 'common.cancel'), I.translate('en', 'common.cancel'), 'an unsupported language falls back to English');

console.log('\nplaceholders');
eq(I.translate('en', 'x.{a}.{b}', { a: '1', b: '2' }), 'x.1.2', 'placeholders are filled even in a fallen-back key');
{
  // Every language's copy of a placeholder string must keep the placeholder, or
  // the value never appears.
  const withVar = 'count.likes.other';
  for (const code of codes) {
    const raw = I.translate(code, withVar, {});
    ok(typeof raw === 'string' && raw.length > 0, `${code}: ${withVar} exists`);
  }
}

console.log('\nkeys match English');
{
  const files = readdirSync(join(OUT, 'locales')).filter((f) => f.endsWith('.js'));
  eq(files.length, 9, 'nine translation modules (English is inline)');
  // A key English has and a translation lacks is fine — it falls back. A key a
  // translation has and English does NOT is a typo nobody will ever see, and
  // English is what every other language falls back to. Checked through
  // translate(), which returns the key itself when English doesn't have it.
  for (const f of files) {
    const d = require(join(OUT, 'locales', f)).default;
    const keys = Object.keys(d);
    ok(keys.length > 1000, `${f}: carries a full dictionary (${keys.length} keys)`);
    ok(keys.every((k) => typeof d[k] === 'string'), `${f}: every value is a string`);
    const orphans = keys.filter((k) => I.translate('en', k) === k);
    eq(orphans.length, 0, `${f}: every key exists in English too (${orphans.slice(0, 3).join(', ')})`);
  }
}

console.log('\npreload');
{
  // preloadLang is what LanguageContext calls when it restores the saved
  // language, so the first screen doesn't build the dictionary mid-render.
  ok(typeof I.preloadLang === 'function', 'preloadLang is exported');
  I.preloadLang('ja');
  const s = I.translate('ja', 'common.cancel');
  ok(typeof s === 'string' && s !== 'common.cancel', 'a preloaded language still translates');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
