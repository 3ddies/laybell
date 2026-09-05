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

// Takes the file as an argument so each release checks its own notes; the 1.0.1
// path stays the default so any existing habit or CI step keeps working.
const FILE = process.argv[2] || 'docs/RELEASE_NOTES_1.0.1.md';
// Play: 500. App Store: 4000. Both are the documented console limits.
const LIMITS = [
  { name: 'Google Play  "What\'s new"', max: 500 },
  { name: 'App Store    "What\'s New"', max: 4000 },
];

const md = await readFile(FILE, 'utf8');

// The paste-ready bodies: fenced blocks with NO language tag.
//
// Parsed by walking the fences, not by regex. The regex this replaces
// (/^```\n([\s\S]*?)^```/gm) could not tell an opening fence from a closing one,
// so the moment a file gained a TAGGED block — a ```bash line showing how to run
// this very script — it began matching from that block's CLOSING fence and
// measured the PROSE between sections instead. It reported 205 and 63 characters
// for bodies of 490 and 3400, and passed.
//
// A checker that silently measures the wrong thing is worse than no checker,
// because it is believed. Hence a real parser: track whether a fence is open and
// what tag opened it, and only collect the untagged ones.
const blocks = [];
{
  let openTag = null;   // the tag of the fence currently open, or null for none
  let buf = [];
  for (const line of md.split('\n')) {
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      if (openTag === null) { openTag = fence[1].trim(); buf = []; }
      else { if (openTag === '') blocks.push(buf.join('\n').trimEnd()); openTag = null; }
      continue;
    }
    if (openTag !== null) buf.push(line);
  }
}

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
