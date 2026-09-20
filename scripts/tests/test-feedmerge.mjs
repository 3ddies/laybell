// Run from the repo root: node scripts/tests/test-feedmerge.mjs
// Tests lib/feedMerge.ts — the shipped source, compiled.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const OUT = join(tmpdir(), 'laybell-tests', 'test-feedmerge');
execSync(`npx tsc lib/feedMerge.ts --outDir "${OUT}" --module esnext --target es2022 --skipLibCheck --strict`, { stdio: 'inherit' });
writeFileSync(join(OUT, 'package.json'), '{"type":"module"}');
const M = await import(pathToFileURL(join(OUT, 'feedMerge.js')).href);

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got  ${g}\n          want ${w}`); }
};
const ids = (list) => list.map((p) => p.id);
const post = (id) => ({ id });
const ad = (id) => ({ id, __ad: { campaignId: 'c' + id } });
const spot = (id) => ({ id, __spotlight: { campaignId: 's' + id } });

console.log('\nsnapshotHead');
eq(ids(M.snapshotHead([post('a'), ad('x'), post('b'), spot('c'), post('d')], 12)), ['a', 'b', 'd'], 'ads and spotlights are never saved');
eq(ids(M.snapshotHead([post('a'), post('b'), post('c')], 2)), ['a', 'b'], 'keeps only the head, in order');
eq(M.snapshotHead([ad('x'), spot('y')], 12), [], 'a feed of promoted items saves nothing');
eq(M.snapshotHead([], 12), [], 'an empty feed saves nothing');

console.log('\nmergeFreshBelow');
eq(ids(M.mergeFreshBelow([post('a'), post('b')], [post('c'), post('a'), post('d')])), ['a', 'b', 'c', 'd'],
  'what is on screen stays first, in place; fresh posts continue below without repeats');
eq(ids(M.mergeFreshBelow([post('a')], [spot('a'), post('b')])), ['a', 'b'],
  'a spotlight of a post already on screen is not shown again');
eq(ids(M.mergeFreshBelow([post('a')], [ad('z'), post('b')])), ['a', 'z', 'b'], 'ads in the fresh feed are kept');
eq(ids(M.mergeFreshBelow([], [post('a'), post('b')])), ['a', 'b'], 'nothing shown: the fresh feed as it is');
eq(ids(M.mergeFreshBelow([post('a'), post('b')], [])), ['a', 'b'], 'an empty fresh feed leaves the screen alone');
const shown = [post('a')];
M.mergeFreshBelow(shown, [post('b')]);
eq(ids(shown), ['a'], 'the list on screen is not mutated');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
