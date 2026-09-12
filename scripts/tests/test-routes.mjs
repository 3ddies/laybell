// Run from the repo root: node scripts/tests/test-routes.mjs
// lib/notificationRoute.ts has no imports, so the shipped source runs directly
// once the types are stripped.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const OUT = join(tmpdir(), 'laybell-tests', 'test-routes');
execSync(`npx tsc lib/notificationRoute.ts --outDir "${OUT}" --module esnext --target es2022 --skipLibCheck`,
  { stdio: 'ignore' });
writeFileSync(join(OUT, 'package.json'), '{"type":"module"}');
const { destForSystemKey, destForPushData } = await import(pathToFileURL(join(OUT, 'notificationRoute.js')).href);

const ME = 'me-123';
let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got  ${g}\n          want ${w}`); }
};

console.log('\nROW / SYSTEM KEYS');
eq(destForSystemKey('earnings', ME),    { href: '/wallet', tab: false },            'earnings -> wallet');
eq(destForSystemKey('badge_first', ME), { href: '/badges', tab: false },            'badge_first -> badges');
eq(destForSystemKey('first_post', ME),  { href: '/(tabs)/post', tab: true },        'first_post -> composer');
eq(destForSystemKey('back', ME),        { href: '/(tabs)/post', tab: true },        '"share something new" -> COMPOSER, not the feed');
eq(destForSystemKey('followers', ME),   { href: `/followers/${ME}`, tab: false },   'followers -> their OWN followers list');
eq(destForSystemKey('unread', ME),      { href: '/notifications', tab: false },     'unread -> the list itself');
eq(destForSystemKey('who_knows', ME),   { href: '/(tabs)', tab: true },             'an unknown key -> the feed, never the composer');
eq(destForSystemKey(null, ME),          { href: '/(tabs)', tab: true },             'a null key -> the feed');

console.log('\nFOLLOWERS WITHOUT A SIGNED-IN ID');
// Must never build /followers/null or /followers/undefined — that would open a
// stranger's list, or a broken screen.
eq(destForSystemKey('followers', null),      { href: '/(tabs)/profile', tab: true }, 'null id -> profile tab');
eq(destForSystemKey('followers', undefined), { href: '/(tabs)/profile', tab: true }, 'missing id -> profile tab');
const noId = destForSystemKey('followers', null);
eq(/null|undefined/.test(noId.href), false, 'and never puts null in the href');

console.log('\nTAPPED PUSH');
eq(destForPushData({ type: 'badge_risk', badge: 'login_gold' }, ME),
   { href: '/badges', tab: false }, 'the badge reminder -> badges');
eq(destForPushData({ type: 'system', key: 'earnings' }, ME),
   { href: '/wallet', tab: false }, 'a system push routes by its key');
eq(destForPushData({ type: 'system', key: 'followers' }, ME),
   { href: `/followers/${ME}`, tab: false }, 'and reaches the followers list too');
eq(destForPushData({ type: 'like', postId: 'p-9' }, ME),
   { href: '/post/p-9', tab: false }, 'a like -> that post');
eq(destForPushData({ type: 'comment', postId: 'p-9' }, ME),
   { href: '/post/p-9', tab: false }, 'a comment -> that post');
eq(destForPushData({ type: 'follow' }, ME),
   { href: '/notifications', tab: false }, 'a follow (no post, no actor) -> the list, which says who');
eq(destForPushData({ type: 'message' }, ME),
   { href: '/notifications', tab: false }, 'a message -> the list');
eq(destForPushData({}, ME),
   { href: '/notifications', tab: false }, 'an empty payload -> the list');
eq(destForPushData(undefined, ME),
   { href: '/notifications', tab: false }, 'NO payload at all does not throw');

console.log('\nCONSISTENCY');
// The row and the push must agree for every system key, or tapping the
// notification and tapping the row would land in different places.
for (const k of ['earnings','badge_first','first_post','back','followers','unread','nonsense']) {
  eq(destForPushData({ type: 'system', key: k }, ME), destForSystemKey(k, ME),
     `row and push agree on "${k}"`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
