// Run from the repo root: node scripts/tests/test-exportplan.mjs
// Tests lib/exportPlan.ts — the shipped source, compiled (with lib/stickerTiming.ts,
// which it imports). Run from the repo root.
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
const OUT = join(tmpdir(), 'laybell-tests', 'test-exportplan');
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'package.json'), '{"type":"commonjs"}');
execSync(`npx tsc lib/exportPlan.ts --outDir "${OUT}" --module commonjs --target es2022 --skipLibCheck`, { stdio: 'inherit' });
const require = createRequire(import.meta.url);
const P = require(join(OUT, 'exportPlan.js'));

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got  ${g}\n          want ${w}`); }
};
const r2 = (n) => Math.round(n * 100) / 100;

console.log('\noutputSize');
eq(P.outputSize({ width: 1080, height: 1920 }), { width: 1080, height: 1920 }, '1080p portrait stays');
eq(P.outputSize({ width: 2160, height: 3840 }), { width: 1080, height: 1920 }, '4K portrait scales to 1920 tall');
eq(P.outputSize({ width: 3840, height: 2160 }), { width: 1920, height: 1080 }, '4K landscape scales to 1920 wide');
eq(P.outputSize({ width: 720, height: 1280 }), { width: 720, height: 1280 }, 'never scaled up');
eq(P.outputSize({ width: 1081, height: 1921 }), { width: 1080, height: 1920 }, 'odd sizes go even (and fit)');
eq(P.outputSize({ width: 1920, height: 1440 }, 1280), { width: 1280, height: 960 }, 'a custom limit');
{
  const s = P.outputSize({ width: 1179, height: 2556 });
  eq([s.width % 2, s.height % 2, s.height <= 1920], [0, 0, true], 'an iPhone screen recording: even and within the limit');
}

console.log('\nscreenRectInFrame');
{
  const r = P.screenRectInFrame({ width: 1080, height: 1920 }, { width: 390, height: 844 });
  eq([r2(r.x), r2(r.y), r2(r.width), r2(r.height)], [96.4, 0, 887.2, 1920], 'a tall phone screen crops the sides of a 9:16 video');
  eq(r2(r.width / r.height), r2(390 / 844), 'the rect has the screen\'s shape');
}
{
  const r = P.screenRectInFrame({ width: 1080, height: 1080 }, { width: 390, height: 844 });
  eq([r2(r.y), r2(r.height)], [0, 1080], 'a square video: full height, sides cropped');
}
{
  const r = P.screenRectInFrame({ width: 900, height: 2400 }, { width: 390, height: 844 });
  eq([r2(r.x), r2(r.width), r2(r.y)], [0, 900, r2((2400 - 900 * 844 / 390) / 2)], 'a video taller than the screen: full width, top and bottom cropped');
}

console.log('\ncaptionSegments');
const A = { id: 'a', text: 'A', x: 0.5, y: 0.5, scale: 1, rotation: 0 };
{
  const segs = P.captionSegments([A], 0, 10);
  eq(segs.map((s) => [s.start, s.end, s.stickers.map((k) => k.id)]), [[0, 10, ['a']]], 'an untimed caption is one image for the whole clip');
}
{
  const B = { ...A, id: 'b', start: 2, end: 5 };
  const segs = P.captionSegments([A, B], 0, 10);
  eq(segs.map((s) => [s.start, s.end, s.stickers.map((k) => k.id)]), [[0, 2, ['a']], [2, 5, ['a', 'b']], [5, 10, ['a']]], 'a timed caption splits the clip where it enters and leaves');
}
{
  const B = { ...A, id: 'b', start: 2, end: 5 };
  const segs = P.captionSegments([B], 0, 10);
  eq(segs.map((s) => [s.start, s.end, s.stickers.map((k) => k.id)]), [[2, 5, ['b']]], 'stretches with no caption are left out');
}
{
  const B = { ...A, id: 'b', start: 2, end: 6 };
  const C = { ...A, id: 'c', start: 4, end: 8 };
  const segs = P.captionSegments([B, C], 0, 10);
  eq(segs.map((s) => [s.start, s.end, s.stickers.map((k) => k.id)]), [[2, 4, ['b']], [4, 6, ['b', 'c']], [6, 8, ['c']]], 'overlapping captions');
}
{
  const B = { ...A, id: 'b', start: 3, end: 6 };
  const segs = P.captionSegments([B], 2, 8);
  eq(segs.map((s) => [s.start, s.end]), [[1, 4]], 'a trimmed window: times come out relative to its start');
}
{
  const B = { ...A, id: 'b', start: 1, end: 4 };
  const C = { ...A, id: 'c', start: 20, end: 30 };
  const segs = P.captionSegments([B, C], 2, 8);
  eq(segs.map((s) => [s.start, s.end, s.stickers.map((k) => k.id)]), [[0, 2, ['b']]], 'captions partly or wholly outside the window');
}
{
  const B = { ...A, id: 'b', start: 2, end: 5 };
  const C = { ...A, id: 'c', start: 5.02, end: 9 };
  const segs = P.captionSegments([B, C], 0, 10);
  eq(segs.map((s) => [s.start, s.end, s.stickers.map((k) => k.id)]), [[2, 5.02, ['b']], [5.02, 9, ['c']]], 'a sliver under 50 ms folds into the stretch before it');
}
{
  const B = { ...A, id: 'b', end: 5 };
  const C = { ...A, id: 'c', start: 5 };
  const segs = P.captionSegments([B, C], 0, 10);
  eq(segs.map((s) => [s.start, s.end, s.stickers.map((k) => k.id)]), [[0, 5, ['b']], [5, 10, ['c']]], 'open ends reach the window edges');
}
{
  const B = { ...A, id: 'b', start: 2, end: 5 };
  const segs = P.captionSegments([B, A], 0, 10);
  eq(segs.length, 3, 'a set that changes is a new image even when the count does not');
}
eq(P.captionSegments([], 0, 10), [], 'no captions, no images');
eq(P.captionSegments([A], 5, 5), [], 'an empty window, no images');
{
  // Every stretch is inside the window, in order, and never overlaps the next.
  const many = Array.from({ length: 20 }, (_, i) => ({ ...A, id: `s${i}`, start: (i * 7) % 13, end: ((i * 7) % 13) + 1 + (i % 4) }));
  const segs = P.captionSegments(many, 0, 15);
  const ok = segs.every((s, i) => s.start >= 0 && s.end <= 15 && s.end > s.start && (i === 0 || segs[i - 1].end <= s.start));
  eq(ok, true, '20 overlapping captions: stretches stay ordered and inside the window');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
