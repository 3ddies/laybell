// Asserts the store release notes fit the limits each store enforces AT
// SUBMISSION. Play rejects a >500-character "what's new" when you press send,
// which is the worst moment to find out, and a word processor's character count
// disagrees with what the console measures often enough not to trust it.
//
//   node scripts/check-release-notes.mjs
//
// Reads the two fenced blocks in docs/RELEASE_NOTES_1.0.1.md in order: Play
// first, App Store second. Exits non-zero if either is over, so this can gate a
// submission step.

import { readFile } from 'node:fs/promises';

const FILE = 'docs/RELEASE_NOTES_1.0.1.md';
// Play: 500. App Store: 4000. Both are the documented console limits.
const LIMITS = [
  { name: 'Google Play  "What\'s new"', max: 500 },
  { name: 'App Store    "What\'s New"', max: 4000 },
];

const md = await readFile(FILE, 'utf8');

// Fenced blocks with no language tag - the two paste-ready bodies.
const blocks = [...md.matchAll(/^```\n([\s\S]*?)^```/gm)].map((m) => m[1].trimEnd());

if (blocks.length !== LIMITS.length) {
  console.error(`Expected ${LIMITS.length} fenced blocks in ${FILE}, found ${blocks.length}.`);
  process.exit(1);
}

let bad = 0;
blocks.forEach((body, i) => {
  const { name, max } = LIMITS[i];
  // Count the way a console does: characters, not bytes and not words. Spread
  // rather than .length so an emoji or accented character counts once rather
  // than as its UTF-16 code units.
  const n = [...body].length;
  const ok = n <= max;
  if (!ok) bad++;
  const bar = ok ? 'OK  ' : 'OVER';
  console.log(`  ${bar}  ${name}  ${n} / ${max}${ok ? `  (${max - n} spare)` : `  — ${n - max} TOO MANY`}`);
});

process.exit(bad ? 1 : 0);
