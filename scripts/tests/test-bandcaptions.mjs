// Run from the repo root: node scripts/tests/test-bandcaptions.mjs
// Tests lib/bandCaptions.ts — the shipped source, compiled (with lib/stickerTiming.ts,
// which it imports). Run from the repo root.
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
const OUT = join(tmpdir(), 'laybell-tests', 'test-bandcaptions');
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'package.json'), '{"type":"commonjs"}');
execSync(`npx tsc lib/bandCaptions.ts --outDir "${OUT}" --module commonjs --target es2022 --skipLibCheck --strict`, { stdio: 'inherit' });
const require = createRequire(import.meta.url);
const B = require(join(OUT, 'bandCaptions.js'));
const T = require(join(OUT, 'stickerTiming.js'));

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got  ${g}\n          want ${w}`); }
};
const r2 = (n) => Math.round(n * 100) / 100;

// iPhone 15 (393 × 852) and iPhone SE (375 × 667), a 16:9 clip.
const P15 = [393, 852];
const SE = [375, 667];
const HD = 16 / 9;

console.log('\ncaptionZone');
{
  const top = B.captionZone('top', HD, ...P15);
  eq([r2(top.band), r2(top.videoH), top.top, r2(top.bottom), r2(top.usable)], [315.47, 221.06, 74, 253.47, 179.47], 'top band on an iPhone 15: below the back button, above the rotate pill');
  const bottom = B.captionZone('bottom', HD, ...P15);
  eq([r2(bottom.top), bottom.bottom, r2(bottom.usable)], [544.53, 612, 67.47], 'bottom band: under the picture, above the reel UI');
  const screen = B.captionZone('screen', HD, ...P15);
  eq([screen.top, screen.bottom, screen.usable], [74, 612, 538], 'screen zone (vertical clips)');
  eq(B.captionZone('bottom', HD, ...SE).usable, 0, 'an iPhone SE leaves no bottom band');
}

console.log('\nbandZones');
{
  const z15 = B.bandZones(HD, ...P15);
  eq([!!z15.top, !!z15.bottom], [true, true], 'iPhone 15: both bands');
  const zSE = B.bandZones(HD, ...SE);
  eq([!!zSE.top, zSE.bottom], [true, null], 'iPhone SE: only the top band');
  const square = B.bandZones(1.05, ...SE);
  eq([square.top, square.bottom], [null, null], 'a nearly square clip on an SE: no room anywhere');
}

console.log('\nbandAt (taps)');
eq(B.bandAt(150, HD, ...P15), 'top', 'a tap in the top band');
eq(B.bandAt(60, HD, ...P15), 'top', 'just above the top band still counts');
eq(B.bandAt(40, HD, ...P15), null, 'well above it does not');
eq(B.bandAt(420, HD, ...P15), null, 'a tap on the picture');
eq(B.bandAt(600, HD, ...P15), 'bottom', 'a tap in the bottom band');
eq(B.bandAt(627, HD, ...P15), 'bottom', 'just below the bottom band still counts');
eq(B.bandAt(640, HD, ...P15), null, 'in the reel UI area does not');
eq(B.bandAt(550, HD, ...SE), null, 'no bottom band to tap on an SE');

console.log('\nnearestBand (dragging)');
eq(B.nearestBand(100, HD, ...P15), 'top', 'above the middle → top');
eq(B.nearestBand(700, HD, ...P15), 'bottom', 'below the middle → bottom');
eq(B.nearestBand(426, HD, ...P15), 'bottom', 'the exact middle goes down');
eq(B.nearestBand(600, HD, ...SE), 'top', 'an SE has only the top band');
eq(B.nearestBand(300, 1.05, ...SE), null, 'no band at all');

console.log('\nfitInZone');
{
  const zone = B.captionZone('top', HD, ...P15);
  const W = P15[0];
  const f = (p) => { const r = B.fitInZone({ cx: 196.5, cy: 150, w: 0, h: 0, scale: 1, rotation: 0, ...p }, zone, W); return [r2(r.cx), r2(r.cy), r2(r.scale)]; };
  eq(f({ cy: 50 }), [196.5, 74, 1], 'an unmeasured caption: its centre kept inside (above)');
  eq(f({ cy: 300 }), [196.5, 253.47, 1], 'an unmeasured caption: its centre kept inside (below)');
  eq(f({ w: 200, h: 40, cy: 80 }), [196.5, 94, 1], 'a measured caption rests whole against the top');
  eq(f({ w: 200, h: 40, cy: 250 }), [196.5, 233.47, 1], 'a measured caption rests whole against the bottom');
  eq(f({ w: 200, h: 40, cx: 10 }), [100, 150, 1], 'and whole inside the screen sideways');
  eq(f({ w: 200, h: 40 }), [196.5, 150, 1], 'one that fits stays put');
  eq(f({ w: 100, h: 100, scale: 3 }), [196.5, 163.73, 1.79], 'too tall: shrunk to the band, centred');
  eq(f({ w: 100, h: 1000 }), [196.5, 163.73, 0.4], 'never below the smallest pinch');
  eq(f({ w: 300, h: 40, rotation: 90 }), [196.5, 163.73, 0.6], 'turned on its side: its rotated height counts');
  eq(f({ w: 500, h: 30 }), [196.5, 150, 0.79], 'too wide: shrunk to the screen, centred');
}

console.log('\nbandToScreenY / screenToBand');
{
  const y = B.bandToScreenY('top', 0.5, HD, ...P15);
  eq(r2(y * 852), r2(74 + 0.5 * 179.46875), 'top band y 0.5 is the middle of the top zone');
  eq(B.screenToBand(y, HD, ...P15), { band: 'top', y: 0.5 }, 'and comes back the same');
  const yb = B.bandToScreenY('bottom', 0.25, HD, ...P15);
  eq(B.screenToBand(yb, HD, ...P15), { band: 'bottom', y: 0.25 }, 'bottom band round trip');
  for (const v of [0, 0.001, 0.123, 0.999, 1]) {
    eq(B.screenToBand(B.bandToScreenY('top', v, HD, ...P15), HD, ...P15).y, v, `round trip keeps ${v}`);
  }
  const moved = B.bandToScreenY('bottom', 0.5, HD, ...SE);
  eq(B.screenToBand(moved, HD, ...SE), { band: 'top', y: 0.5 }, 'a bottom caption on an SE shows in the top band');
  eq(B.screenToBand(0, HD, ...P15), { band: 'top', y: 0 }, 'the top of the screen clamps into the top band');
  eq(B.screenToBand(0.5, HD, ...P15), { band: 'bottom', y: 0 }, 'the middle of the picture clamps to the bottom band\'s top');
  eq(r2(B.bandToScreenY('top', NaN, HD, ...P15) * 852), r2(74 + 0.5 * 179.46875), 'a broken y lands mid-band');
}

console.log('\nisBandSticker / hasBandStickers');
eq([B.isBandSticker({ band: 'top' }), B.isBandSticker({ band: 'bottom' }), B.isBandSticker({ band: 'left' }), B.isBandSticker({}), B.isBandSticker(null)], [true, true, false, false, false], 'only top and bottom are bands');
eq([B.hasBandStickers([{ text: 'a' }, { band: 'bottom' }]), B.hasBandStickers([{ text: 'a' }]), B.hasBandStickers(null), B.hasBandStickers('x')], [true, false, false, false], 'a post holds band captions');

console.log('\nlegacyBandCaption');
eq(B.legacyBandCaption([], 'top'), null, 'no captions, no bubble');
eq(
  B.legacyBandCaption([{ band: 'top', text: ' Hi ', y: 0.4, bg: 'boxy', color: '#FFFFFF', size: 26, scale: 1 }], 'top'),
  { text: 'Hi', bg: '#FFFFFF', color: '#0A0A0A', y: 0.4, scale: 1 },
  'a white boxy caption: a white bubble with dark text, no bigger than a bubble',
);
eq(
  B.legacyBandCaption([
    { band: 'top', text: 'second', y: 0.8, bg: 'boxy', color: '#111111' },
    { band: 'top', text: 'first', y: 0.1, bg: 'none', color: '#F26522', size: 26, scale: 1 },
    { band: 'top', text: 'timed', y: 0.5, start: 2 },
    { band: 'bottom', text: 'other', y: 0.5 },
    { band: 'top', text: '   ', y: 0.3 },
  ], 'top'),
  { text: 'first\nsecond', bg: 'transparent', color: '#F26522', y: 0.1, scale: 1 },
  'whole-video captions of that band only, top to bottom, dressed like the first',
);
eq(B.legacyBandCaption([{ band: 'bottom', text: 'x', y: 0.5, bg: 'soft', color: '#FAB525' }], 'bottom').bg, 'rgba(0,0,0,0.45)', 'soft keeps its dark backing');
eq(B.legacyBandCaption([{ band: 'bottom', text: 'x', y: 0.5, bg: 'pill', color: '#111111' }], 'bottom').color, '#FFFFFF', 'a dark pill gets white text');
eq(B.legacyBandCaption([{ band: 'top', text: 'x', y: 0.5, size: 60, scale: 1 }], 'top').scale, 1, 'never bigger than its default size (older apps do not shrink it)');
eq(B.legacyBandCaption([{ band: 'top', text: 'x', y: 0.5, size: 5, scale: 1 }], 'top').scale, 0.5, 'size clamps low');
eq(B.legacyBandCaption([{ band: 'top', text: 'x', y: 0.5, start: 0.5, end: 3 }], 'top'), null, 'a timed caption alone makes no bubble');
eq(B.legacyBandCaption([{ band: 'top', text: 'a'.repeat(60), y: 0.5 }], 'top').text, `${'a'.repeat(51)}…`, 'a caption longer than two rows is cut short');
eq(
  B.legacyBandCaption([
    { band: 'top', text: 'three', y: 0.3 },
    { band: 'top', text: 'one', y: 0.1 },
    { band: 'top', text: 'two', y: 0.2 },
  ], 'top').text,
  'one\ntwo…',
  'more captions than two rows: the last one shown says there are more',
);
eq(B.legacyBandCaption([{ band: 'top', text: 'first line\nsecond line', y: 0.5 }], 'top').text, 'first line\nsecond line', 'two short lines fit as they are');
eq(B.legacyBandCaption([{ band: 'top', text: '你好'.repeat(14), y: 0.5 }], 'top').text, `${'你好'.repeat(12)}你…`, 'wide characters count double');
eq(B.legacyBandCaption([{ band: 'top', text: '🎵'.repeat(20), y: 0.5 }], 'top').text, `${'🎵'.repeat(20)}`, 'emoji count double, whole characters (40 units fit two rows)');
eq(B.legacyBandCaption([{ band: 'bottom', text: 'b'.repeat(40), y: 0.5 }], 'bottom').text, 'b'.repeat(40), "the bottom band's narrower rows: 40 fit in two");
eq(B.legacyBandCaption([{ band: 'bottom', text: 'b'.repeat(41), y: 0.5 }], 'bottom').text, `${'b'.repeat(39)}…`, 'and 41 do not');

console.log('\nbandStickersFromLegacy');
eq(B.bandStickersFromLegacy(null, undefined), [], 'nothing to convert');
eq(
  B.bandStickersFromLegacy({ text: 'Hello', bg: '#FFFFFF', color: '#111111', y: 0.35, scale: 1 }, null),
  [{ id: 'band-top', text: 'Hello', band: 'top', x: 0.5, y: 0.35, scale: 1, rotation: 0, font: 'bold', size: 17, bg: 'boxy', color: '#FFFFFF' }],
  'a bubble becomes a centred boxy caption in its colours',
);
eq(
  B.bandStickersFromLegacy(null, { text: 'Bye', bg: 'transparent', color: '#F26522', y: 0.2, scale: 2 }).map((s) => [s.band, s.bg, s.color, s.size]),
  [['bottom', 'none', '#F26522', 34]],
  'a clear bubble becomes plain text',
);
eq(
  B.bandStickersFromLegacy({ text: 'a', bg: 'rgba(0,0,0,0.45)', color: '#FFFFFF', y: 0.5, scale: 1 }, null)[0].bg,
  'soft',
  'the soft backing comes back as soft',
);
eq(B.bandStickersFromLegacy({ text: '  ', bg: '#FFFFFF' }, { nope: true }), [], 'blank or broken bubbles are skipped');
{
  const back = B.legacyBandCaption(B.bandStickersFromLegacy({ text: 'Hello', bg: '#F43F5E', color: '#FFFFFF', y: 0.35, scale: 1.2 }, null), 'top');
  eq(back, { text: 'Hello', bg: '#F43F5E', color: '#FFFFFF', y: 0.35, scale: 1 }, 'bubble → caption → bubble: same words, colours and place, at most the default size');
}

console.log('\ntimingForPublish (lib/stickerTiming)');
eq(
  T.timingForPublish([{ id: 'a', start: 0.1, end: 9.9 }, { id: 'b', start: 3, end: 5 }, { id: 'c' }], 0, 10),
  [{ id: 'a' }, { id: 'b', start: 3, end: 5 }, { id: 'c' }],
  "edges within reach open up; the editor's order is kept",
);
eq(
  T.splitForPublish([{ id: 'a', start: 3 }, { id: 'b' }], 0, 10),
  { always: [{ id: 'b' }], timed: [{ id: 'a', start: 3 }] },
  'splitForPublish still splits the same way',
);

console.log('\nexportBandZone (a saved upright frame)');
{
  const W = 393, H = (393 * 16) / 9;
  const top = B.exportBandZone('top', HD, W, H);
  const bottom = B.exportBandZone('bottom', HD, W, H);
  eq([r2(top.band), r2(top.videoH), r2(top.top), r2(top.bottom)], [238.8, 221.06, 23.58, 227.01], 'top band of a 9:16 frame: a margin from the edge, a gap above the picture');
  eq([r2(bottom.top), r2(bottom.bottom)], [471.65, 675.09], 'bottom band: a gap under the picture, a margin from the edge');
  eq(r2(top.usable), r2(bottom.usable), 'both bands the same size');
  eq(r2(B.exportBandZone('top', 1, W, H).usable), r2((H - W) / 2 - W * 0.09), 'a square clip still leaves bands');
  eq(r2(B.exportBandZone('top', HD, 1080, 1920).bottom / (1080 / 393)), r2(top.bottom), 'the same zone at any scale');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
