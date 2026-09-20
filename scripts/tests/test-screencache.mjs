// Run from the repo root: node scripts/tests/test-screencache.mjs
// Tests lib/screenCache.ts and lib/startupGate.ts — the shipped sources, compiled.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const OUT = join(tmpdir(), 'laybell-tests', 'test-screencache');
execSync(`npx tsc lib/screenCache.ts lib/startupGate.ts --outDir "${OUT}" --module esnext --target es2022 --skipLibCheck --strict`, { stdio: 'inherit' });
writeFileSync(join(OUT, 'package.json'), '{"type":"module"}');
const C = await import(pathToFileURL(join(OUT, 'screenCache.js')).href);
const G = await import(pathToFileURL(join(OUT, 'startupGate.js')).href);

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got  ${g}\n          want ${w}`); }
};

console.log('\ncreateScreenCache');
{
  const c = C.createScreenCache(3);
  eq(c.get('a'), undefined, 'a miss is undefined');
  c.set('a', 1); c.set('b', 2); c.set('c', 3);
  eq([c.get('a'), c.get('b'), c.get('c'), c.size], [1, 2, 3, 3], 'holds up to its limit');
  c.get('a');           // a is now the most recent
  c.set('d', 4);        // evicts the least recent: b
  eq([c.get('b'), c.get('a'), c.get('d'), c.size], [undefined, 1, 4, 3], 'evicts the least recently used, not the oldest written');
  c.set('a', 10);
  eq([c.get('a'), c.size], [10, 3], 'setting an existing key replaces it without growing');
  c.delete('a');
  eq([c.get('a'), c.size], [undefined, 2], 'delete removes one entry');
  c.set('f', false);
  eq(c.get('f'), false, 'a falsy value is returned, not treated as a miss');
}
{
  const a = C.createScreenCache(5), b = C.createScreenCache(5);
  a.set('x', 1); b.set('y', 2);
  C.clearScreenCaches();
  eq([a.size, b.size, a.get('x'), b.get('y')], [0, 0, undefined, undefined], 'clearScreenCaches empties every cache (account change)');
}

console.log('\nstartupGate');
{
  const t0 = Date.now();
  await G.afterHomePaint(80);
  const waited = Date.now() - t0;
  eq(waited >= 70 && waited < 400, true, `with no paint it gives up after its limit (${waited}ms)`);

  let released = false;
  const p = G.afterHomePaint(5000).then(() => { released = true; });
  await new Promise((r) => setTimeout(r, 20));
  eq(released, false, 'still waiting before the paint');
  G.markHomePainted();
  await p;
  eq(released, true, "Home's paint releases the waiters");

  const t1 = Date.now();
  await G.afterHomePaint(5000);
  eq(Date.now() - t1 < 50, true, 'after the paint, later callers do not wait');
  G.markHomePainted();
  eq(true, true, 'marking twice is harmless');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
