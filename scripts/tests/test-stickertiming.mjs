// Run from the repo root: node scripts/tests/test-stickertiming.mjs
// Tests lib/stickerTiming.ts — the shipped source, compiled. Run from the repo root.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const OUT = join(tmpdir(), 'laybell-tests', 'test-stickertiming');
execSync(`npx tsc lib/stickerTiming.ts --outDir "${OUT}" --module esnext --target es2022 --skipLibCheck`, { stdio: 'inherit' });
writeFileSync(join(OUT, 'package.json'), '{"type":"module"}');
const T = await import(pathToFileURL(join(OUT, 'stickerTiming.js')).href);

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got  ${g}\n          want ${w}`); }
};

console.log('\nshowsAt / isTimed');
eq([0, 5, 999].map((t) => T.showsAt({}, t)), [true, true, true], 'an untimed caption (every pre-1.0.3 caption) always shows');
eq([1.9, 2, 7].map((t) => T.showsAt({ start: 2 }, t)), [false, true, true], 'start is inclusive');
eq([0, 3.99, 4].map((t) => T.showsAt({ end: 4 }, t)), [true, true, false], 'end is exclusive, so back-to-back captions never overlap');
eq([T.isTimed({}), T.isTimed({ start: null, end: undefined }), T.isTimed({ end: 3 })], [false, false, true], 'null and undefined are untimed');

console.log('\nvisibleKey');
const set = [{}, { start: 2, end: 4 }, { start: 3 }];
eq([0, 2, 2.5, 3, 4].map((t) => T.visibleKey(set, t)), ['|0|', '|0|1|', '|0|1|', '|0|1|2|', '|0|2|'], 'the key changes only when a caption enters or leaves');
eq(T.visibleKey(Array.from({ length: 12 }, () => ({})), 0).includes('|1|'), true, 'delimited, so index 1 is never mistaken for 11');

console.log('\nresolveWindow');
eq(T.resolveWindow({}, 10, 40), { start: 10, end: 40 }, 'an untimed caption spans the whole window');
eq(T.resolveWindow({ start: 5, end: 50 }, 10, 40), { start: 10, end: 40 }, 'times outside the window are clamped into it');
eq(T.resolveWindow({ start: 30, end: 20 }, 10, 40), { start: 20, end: 30 }, 'a reversed range is put right');
eq(T.resolveWindow({ start: 10.2, end: 39.8 }, 10, 40), { start: 10, end: 40 }, 'within a quarter second of an edge snaps to the edge');
eq(T.resolveWindow({ start: 20, end: 20.1 }, 10, 40), { start: 20, end: 20.5 }, 'too brief is widened to half a second');
eq(T.resolveWindow({ start: 39.9, end: 40 }, 10, 40), { start: 39.5, end: 40 }, 'widening at the very end grows backwards');
eq(T.resolveWindow({ start: 0.1, end: 0.2 }, 0, 0.3), { start: 0, end: 0.3 }, 'a window shorter than the minimum is used whole');

console.log('\nsplitForPublish');
{
  const { always, timed } = T.splitForPublish([
    { id: 'a', text: 'whole' },
    { id: 'b', text: 'explicit whole', start: 0, end: 30 },
    { id: 'c', text: 'middle', start: 5, end: 9 },
    { id: 'd', text: 'from 12', start: 12 },
    { id: 'e', text: 'until 3', end: 3 },
    { id: 'f', text: 'nearly whole', start: 0.1, end: 29.9 },
  ], 0, 30);
  eq(always.map((s) => s.id), ['a', 'b', 'f'], 'captions covering the whole video go to posts.captions');
  eq(always.every((s) => !('start' in s) && !('end' in s)), true, '...with no timing fields, exactly what older apps render');
  eq(timed, [
    { id: 'c', text: 'middle', start: 5, end: 9 },
    { id: 'd', text: 'from 12', start: 12 },
    { id: 'e', text: 'until 3', end: 3 },
  ], 'partial captions go to posts.timed_captions, with an edge-reaching side left open');
}
{
  const { always, timed } = T.splitForPublish([{ id: 'x', text: 'hi', start: 50, end: 70 }], 60, 120);
  eq([always.length, timed], [0, [{ id: 'x', text: 'hi', end: 70 }]], 'a trim window clamps a caption placed before it; the start reaches the window edge, so it stays open');
}
{
  const { always, timed } = T.splitForPublish([{ id: 'y', text: 'hi', start: 3.14159, end: 5 }], 0, 0);
  eq([always.length, timed.length], [1, 0], 'an unknown duration (0) publishes everything as always-on, never lost');
}
eq(T.splitForPublish([{ id: 'z', text: 'r', start: 1.23456, end: 4.56789 }], 0, 10).timed[0], { id: 'z', text: 'r', start: 1.23, end: 4.57 }, 'times are stored to the hundredth');
{
  const input = [{ id: 'k', text: 'keep', start: 2, end: 4, x: 0.5, y: 0.4, scale: 1.2, rotation: 7, font: 'bold', emoji: false }];
  T.splitForPublish(input, 0, 10);
  eq(input[0], { id: 'k', text: 'keep', start: 2, end: 4, x: 0.5, y: 0.4, scale: 1.2, rotation: 7, font: 'bold', emoji: false }, "the editor's own stickers are not mutated");
}

console.log('\nshiftTimes');
eq(T.shiftTimes([{ start: 65, end: 70 }, { end: 62 }, {}], 60), [{ start: 5, end: 10 }, { end: 2 }, {}], 'a physically cut file moves every time back by the cut');
eq(T.shiftTimes([{ start: 59.5 }], 60), [{ start: 0 }], 'never negative');
{ const same = [{ start: 3 }]; eq(T.shiftTimes(same, 0) === same, true, 'no cut, no copy'); }

console.log('\ntimingForNew');
eq(T.timingForNew(0, 0, 30), {}, 'added at the start → the whole video');
eq(T.timingForNew(12.345, 0, 30), { start: 12.35 }, 'added mid-video → from the playhead to the end');
eq(T.timingForNew(29.8, 0, 30), {}, 'too close to the end to show at all → the whole video instead');
eq(T.timingForNew(60.1, 60, 90), {}, 'the start of a trim window counts as the start');

console.log('\npostStickers / hasPostStickers');
{
  const caps = [{ id: 1 }];
  eq(T.postStickers(caps, null) === caps, true, 'no timed captions → the same array, so memos hold');
  eq(T.postStickers(caps, [{ id: 2 }]), [{ id: 1 }, { id: 2 }], 'both columns merge');
  eq(T.postStickers('garbage', { not: 'an array' }), [], 'malformed columns render nothing instead of crashing');
  eq([T.hasPostStickers(null, []), T.hasPostStickers([], [{}]), T.hasPostStickers([{}], null)], [false, true, true], 'hasPostStickers');
}

console.log('\nround trip');
{
  // Whatever the editor produces, the published split must show each caption at
  // exactly the moments its resolved window covers.
  let bad = null;
  for (let i = 0; i < 2000 && !bad; i++) {
    const lo = Math.round(Math.random() * 50), hi = lo + 1 + Math.round(Math.random() * 60);
    const s = { id: String(i), text: 't' };
    if (Math.random() < 0.7) s.start = lo - 5 + Math.random() * (hi - lo + 10);
    if (Math.random() < 0.7) s.end = lo - 5 + Math.random() * (hi - lo + 10);
    const w = T.resolveWindow(s, lo, hi);
    const { always, timed } = T.splitForPublish([s], lo, hi);
    const pub = always[0] ?? timed[0];
    // Sample strictly inside the window: the window's own end instant is where
    // the video wraps, and nothing is on screen to judge there.
    for (let k = 0; k < 40; k++) {
      const t = lo + ((hi - lo) * k) / 40;
      if (Math.abs(t - w.start) < 0.01 || Math.abs(t - w.end) < 0.01) continue; // rounding boundary
      const want = t >= w.start && t < w.end;
      const got = T.showsAt(pub, t);
      if (want !== got) { bad = { s, w, pub, t, want, got }; break; }
    }
  }
  eq(bad, null, 'the published caption shows exactly where its window says (2,000 random captions)');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
