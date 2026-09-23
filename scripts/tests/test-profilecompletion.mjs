// Run from the repo root: node scripts/tests/test-profilecompletion.mjs
// Tests lib/profileCompletion.ts — the shipped source, compiled.
//
// These rules are read in two places that must never disagree: the card on the
// profile page, and the Bronze Profile badge in lib/badges. A badge that says
// you are done while the card still lists a task (or the reverse) is the kind of
// thing users screenshot.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const OUT = join(tmpdir(), 'laybell-tests', 'test-profilecompletion');
execSync(`npx tsc lib/profileCompletion.ts --outDir "${OUT}" --module esnext --target es2022 --skipLibCheck --strict`, { stdio: 'inherit' });
writeFileSync(join(OUT, 'package.json'), '{"type":"module"}');
const P = await import(pathToFileURL(join(OUT, 'profileCompletion.js')).href);

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got  ${g}\n          want ${w}`); }
};
const ok = (cond, label) => eq(!!cond, true, label);

const FULL = { avatarUrl: 'https://x/a.jpg', bio: 'hi', posts: 2, hasShop: true };

console.log('\nthe four tasks');
eq(P.PROFILE_TASK_ORDER, ['avatar', 'bio', 'post', 'shop'], 'listed easiest-first, shop last');
eq(P.profileTasks({}).map((t) => t.key), P.PROFILE_TASK_ORDER, 'always the same four, in order');
eq(P.profileProgress({}), { done: 0, total: 4, complete: false }, 'an empty profile has done none');
eq(P.profileProgress(FULL), { done: 4, total: 4, complete: true }, 'a full profile is complete');

console.log('\nwhat counts as done');
ok(!P.profileProgress({ avatarUrl: '' }).done, 'an empty avatar url is not a picture');
ok(!P.profileProgress({ avatarUrl: '   ' }).done, 'nor is whitespace');
eq(P.profileProgress({ avatarUrl: 'https://x/a.jpg' }).done, 1, 'a real avatar url counts');
ok(!P.profileProgress({ bio: '   \n ' }).done, 'a whitespace bio is no bio — the same rule the page uses');
eq(P.profileProgress({ bio: 'b' }).done, 1, 'one character of bio counts');
ok(!P.profileProgress({ posts: 0 }).done, 'zero posts is not a post');
eq(P.profileProgress({ posts: 1 }).done, 1, 'one post counts');
ok(!P.profileProgress({ hasShop: false }).done, 'no shop is not a shop');
eq(P.profileProgress({ hasShop: true }).done, 1, 'an open shop counts');

console.log('\nmissing data is never a false yes');
// The card renders before the shop check and the post count have landed. Claiming
// a task is done and then un-ticking it a moment later is worse than waiting.
ok(!P.profileProgress({ posts: null, hasShop: null, bio: null, avatarUrl: null }).complete, 'nulls read as not done');
ok(!P.profileProgress({ posts: undefined, hasShop: undefined }).complete, 'so does undefined');
eq(P.profileProgress({ avatarUrl: 'u', bio: 'b', posts: 3 }).done, 3, 'three of four while the shop is still unknown');

console.log('\npartial progress');
eq(P.profileProgress({ avatarUrl: 'u' }), { done: 1, total: 4, complete: false }, 'one of four');
eq(P.profileProgress({ avatarUrl: 'u', bio: 'b' }), { done: 2, total: 4, complete: false }, 'two of four');
eq(
  P.profileTasks({ avatarUrl: 'u', hasShop: true }).map((t) => [t.key, t.done]),
  [['avatar', true], ['bio', false], ['post', false], ['shop', true]],
  'each task reports itself, in order, whichever ones are done',
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
