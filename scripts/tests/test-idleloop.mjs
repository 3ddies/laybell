// Run from the repo root: node scripts/tests/test-idleloop.mjs
// Tests lib/idleLoopCore.ts — the shipped source, compiled — for both modes.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const OUT = join(tmpdir(), 'laybell-tests', 'test-idleloop');
execSync(`npx tsc lib/idleLoopCore.ts --outDir "${OUT}" --module esnext --target es2022 --skipLibCheck`, { stdio: 'inherit' });
writeFileSync(join(OUT, 'package.json'), '{"type":"module"}');
const C = await import(pathToFileURL(join(OUT, 'idleLoopCore.js')).href);

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got  ${g}\n          want ${w}`); }
};
const S0 = () => C.initialIdleLoopState();

console.log('\nPAUSE MODE — previews nobody asked to watch');
{
  const [s, cmd] = C.wentIdle(S0(), { mode: 'pause', playing: true });
  eq(cmd, { kind: 'pause' }, 'going idle while playing pauses IMMEDIATELY — the Explore fix');
  eq(s.pausedForIdle, true, 'and remembers that it was us who paused it');

  const [, back] = C.cameBack(s, { shouldPlay: true, restartSec: 5 });
  eq(back, { kind: 'play' }, 'a touch resumes from the same spot — no seek, no restart');

  const [cleared, nothing] = C.cameBack(s, { shouldPlay: false });
  eq(nothing, { kind: 'none' }, 'nothing resumes if the tile scrolled away meanwhile');
  eq(cleared, S0(), 'and the stale pause flag is cleared so it cannot fire later');
}
{
  const [s, cmd] = C.wentIdle(S0(), { mode: 'pause', playing: false });
  eq(cmd, { kind: 'none' }, 'going idle while already paused does nothing');
  eq(C.cameBack(s, { shouldPlay: true })[1], { kind: 'none' }, 'and does not start something the user had paused');
}
{
  const [s, cmd] = C.playingChanged(S0(), { isPlaying: true, idle: true, mode: 'pause' });
  eq(cmd, { kind: 'pause' }, 'anything that starts playback while idle is paused again (self-heal, readiness)');
  eq(s.pausedForIdle, true, 'and counts as ours to resume');
  eq(C.playingChanged(S0(), { isPlaying: true, idle: false, mode: 'pause' })[1], { kind: 'none' },
    'playback starting while someone is present is left alone');
  eq(C.playingChanged(S0(), { isPlaying: false, idle: true, mode: 'pause' })[1], { kind: 'none' },
    'a stop while idle needs nothing');
}

console.log('\nFINISH-PASS MODE — video somebody opened');
{
  eq(C.wentIdle(S0(), { mode: 'finishPass', playing: true })[1], { kind: 'none' },
    'going idle NEVER pauses a video somebody opened');
  eq(C.playingChanged(S0(), { isPlaying: true, idle: true, mode: 'finishPass' })[1], { kind: 'none' },
    'and playback while idle is allowed — watching a film is touch-free');
  eq(C.nativeLoop(true, true), false, 'but the NEXT repeat is withheld while idle');
  eq(C.nativeLoop(true, false), true, 'and restored when someone is back');
  eq(C.nativeLoop(false, false), false, 'a non-looping surface is never made to loop');
}
{
  const ended = C.reachedEnd(S0(), { idle: true, loop: true });
  eq(ended.endedWhileIdle, true, 'a looping pass that ends while idle is a real end');
  eq(C.cameBack(ended, { shouldPlay: true, restartSec: 12.5 })[1], { kind: 'restart', atSec: 12.5 },
    'a touch restarts it from its trim start');
  eq(C.cameBack(ended, { shouldPlay: true, restartSec: null })[1], { kind: 'restart', atSec: 0 },
    'or from zero when there is no trim');
  eq(C.cameBack(ended, { shouldPlay: true, restartSec: -3 })[1], { kind: 'restart', atSec: 0 },
    'never from a negative time');
}
{
  eq(C.reachedEnd(S0(), { idle: false, loop: true }), S0(),
    'an end while present is an ordinary loop wrap (iOS reports those too) — ignored');
  eq(C.reachedEnd(S0(), { idle: true, loop: false }), S0(),
    'a NON-looping video ending while idle (a story) is not flagged');
  eq(C.cameBack(C.reachedEnd(S0(), { idle: true, loop: false }), { shouldPlay: true })[1], { kind: 'none' },
    'so a story that simply ended is never restarted');
}
{
  const trimmed = C.manualEnd(S0());
  eq(C.cameBack(trimmed, { shouldPlay: true, restartSec: 4 })[1], { kind: 'restart', atSec: 4 },
    'a manual trim loop stopped at trimEnd restarts at trimStart');
}

console.log('\nPRECEDENCE');
{
  const both = { pausedForIdle: true, endedWhileIdle: true };
  eq(C.cameBack(both, { shouldPlay: true, restartSec: 9 })[1], { kind: 'play' },
    'paused mid-video beats ended: resume where it was rather than jump to the start');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
