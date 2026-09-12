// Run from the repo root: node scripts/tests/test-songmix.mjs
// Tests lib/songMix.ts and lib/waveformBars.ts — the shipped sources, compiled.
// Run from the repo root.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const OUT = join(tmpdir(), 'laybell-tests', 'test-songmix');
execSync(`npx tsc lib/songMix.ts lib/waveformBars.ts --outDir "${OUT}" --module esnext --target es2022 --skipLibCheck`, { stdio: 'inherit' });
writeFileSync(join(OUT, 'package.json'), '{"type":"module"}');
const M = await import(pathToFileURL(join(OUT, 'songMix.js')).href);
const W = await import(pathToFileURL(join(OUT, 'waveformBars.js')).href);

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got  ${g}\n          want ${w}`); }
};

console.log('\nmixFromPost / ambientMixFor / videoSoundFor');
eq(M.mixFromPost({}), { startSec: 0, songVolume: 1, videoVolume: 0, custom: false }, 'a post without a mix plays as every song post always has');
eq(M.mixFromPost(null), { startSec: 0, songVolume: 1, videoVolume: 0, custom: false }, 'no post at all');
eq(M.mixFromPost({ song_start_sec: 42.5, song_volume: 0.8, video_volume: 0.3 }), { startSec: 42.5, songVolume: 0.8, videoVolume: 0.3, custom: true }, 'a saved mix reads back');
eq(M.mixFromPost({ song_start_sec: -3, song_volume: 7, video_volume: -1 }), { startSec: 0, songVolume: 1, videoVolume: 0, custom: true }, 'out-of-range values clamp (a negative start is treated as no start)');
eq(M.mixFromPost({ song_start_sec: '12', song_volume: 'loud' }), { startSec: 0, songVolume: 1, videoVolume: 0, custom: false }, 'non-numbers are ignored');
eq(M.ambientMixFor({}), { startSec: null, volume: 1, videoStartSec: 0 }, 'a legacy post never syncs to the video');
eq(M.ambientMixFor({ song_start_sec: 30, song_volume: 0.5, video_volume: 0.2, trim_start: 12 }), { startSec: 30, volume: 0.5, videoStartSec: 12 }, 'a mixed post syncs from the trimmed start');
eq(M.ambientMixFor({ song_volume: 0.6 }), { startSec: 0, volume: 0.6, videoStartSec: 0 }, 'any saved field makes it a synced mix, starting at 0');
eq(M.videoSoundFor({}, false), { muted: true, volume: 0 }, 'without a mix the video stays silent under its song');
eq(M.videoSoundFor({ video_volume: 0.4 }, false), { muted: false, volume: 0.4 }, 'the saved original-sound level plays');
eq(M.videoSoundFor({ video_volume: 0.4 }, true), { muted: true, volume: 0.4 }, 'the one sound button mutes the video too');

console.log('\nclampStart');
eq(M.clampStart(100, 180, 15), 100, 'a start with room for the whole video stays');
eq(M.clampStart(175, 180, 15), 165, 'a start too close to the end moves back so the video fills with song');
eq(M.clampStart(30, 10, 15), 0, 'a song shorter than the video can only start at 0');
eq(M.clampStart(-5, 180, 15), 0, 'never negative');
eq(M.clampStart(42.37, 0, 15), 42.3, 'unknown song length keeps the start, in tenths');
eq(M.clampStart(165.99, 180.95, 15), 165.9, 'rounding never passes the latest start');

console.log('\nsongPositionFor / isVideoWrap');
eq(M.songPositionFor(30, 0, 0, 180), 30, 'video at its first second → song at the chosen start');
eq(M.songPositionFor(30, 4.5, 0, 180), 34.5, 'the song keeps pace with the video');
eq(M.songPositionFor(30, 17, 12, 180), 35, 'a trimmed video counts from its trim start');
eq(M.songPositionFor(170, 15, 0, 180), 175, 'past the end of the song it wraps to the chosen start (170 + (185-170) % 10)');
eq(M.songPositionFor(30, 4, 0, 0), 34, 'an unknown song length never wraps');
eq(M.songPositionFor(30, 5, 10, 180), 30, 'a position before the trim start counts as the start');
eq([M.isVideoWrap(14.8, 0.1), M.isVideoWrap(3, 2.5), M.isVideoWrap(5, 5.25), M.isVideoWrap(NaN, 0)], [true, false, false, false], 'only a jump back of more than a second is a loop');

console.log('\npercent / formatClock / mixColumns');
eq([M.percent(0), M.percent(0.304), M.percent(1), M.percent(2), M.percent(NaN)], [0, 30, 100, 100, 0], 'percent');
eq([M.formatClock(0), M.formatClock(42.9), M.formatClock(125), M.formatClock(-4)], ['0:00', '0:42', '2:05', '0:00'], 'formatClock');
eq(M.mixColumns({ startSec: 42.37, songVolume: 0.8049, videoVolume: 1.5 }), { song_start_sec: 42.3, song_volume: 0.8, video_volume: 1 }, 'columns are clamped and rounded, inside the database check');

console.log('\nwaveformBars');
{
  const a = W.barsFor('song-123', 68), b = W.barsFor('song-123', 68), c = W.barsFor('song-124', 68);
  eq(JSON.stringify(a) === JSON.stringify(b), true, 'the same song always draws the same bars');
  eq(JSON.stringify(a) === JSON.stringify(c), false, 'a different song draws differently');
  eq(a.length === 68 && a.every((v) => v > 0 && v <= 1), true, 'bars are in (0, 1]');
  // The immersive player's original function, copied here before it moved: the
  // shared one must draw every song exactly as it always has.
  function original(seed) {
    const BARS = 68;
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
    const out = [];
    for (let i = 0; i < BARS; i++) {
      h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h |= 0;
      const r = Math.abs(h % 1000) / 1000;
      const swell = 0.55 + 0.45 * Math.sin((i / BARS) * Math.PI * 2.3);
      out.push(0.22 + 0.78 * (0.35 * r + 0.65 * swell) * (0.6 + 0.4 * r));
    }
    return out;
  }
  eq(['laybell', 'song-123', '0c1d2e3f-aaaa'].every((s) => JSON.stringify(W.barsFor(s, 68)) === JSON.stringify(original(s))), true, 'moving it out of ImmersivePlayer changed no song\'s bars');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
