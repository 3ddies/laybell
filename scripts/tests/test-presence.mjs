// Run from the repo root: node scripts/tests/test-presence.mjs
// Proves lib/presenceCore.ts — the shipped source, compiled — against a fake
// clock, so five-minute behaviour is tested in milliseconds and exactly.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const OUT = join(tmpdir(), 'laybell-tests', 'test-presence');
execSync(`npx tsc lib/presenceCore.ts --outDir "${OUT}" --module esnext --target es2022 --skipLibCheck`, { stdio: 'inherit' });
writeFileSync(join(OUT, 'package.json'), '{"type":"module"}');
const { createPresence } = await import(pathToFileURL(join(OUT, 'presenceCore.js')).href);

const MIN = 60_000;
const BUDGET = 5 * MIN;

function fakeClock() {
  let t = 0, seq = 0, armedCount = 0;
  const timers = new Map();
  return {
    clock: {
      now: () => t,
      setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); armedCount++; return id; },
      clearTimeout: (id) => { timers.delete(id); },
    },
    // Runs due timers in time order, moving the clock to each as it fires.
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, x] of timers) if (x.at <= end && (!next || x.at < next[1].at)) next = [id, x];
        if (!next) break;
        t = next[1].at; timers.delete(next[0]); next[1].fn();
      }
      t = end;
    },
    get armedCount() { return armedCount; },
    get pending() { return timers.size; },
  };
}

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? `  — ${extra}` : ''}`); }
};

function setup() {
  const fc = fakeClock();
  const p = createPresence(BUDGET, fc.clock);
  let emits = 0;
  p.subscribe(() => { emits++; });
  return { fc, p, get emits() { return emits; } };
}

console.log('\nGOING IDLE');
{
  const s = setup();
  s.fc.advance(BUDGET - 1);
  ok(!s.p.isIdle(), 'not idle one millisecond before the budget');
  s.fc.advance(1);
  ok(s.p.isIdle(), 'idle at exactly the budget');
  ok(s.emits === 1, 'announced exactly once', `emits=${s.emits}`);
  s.fc.advance(60 * MIN);
  ok(s.emits === 1, 'an hour more of silence announces nothing further', `emits=${s.emits}`);
  ok(s.fc.pending === 0, 'no timer left running while idle — nothing polls an empty room', `pending=${s.fc.pending}`);
}

console.log('\nA TOUCH PUSHES IT BACK');
{
  const s = setup();
  s.fc.advance(BUDGET - 1_000);          // 4:59
  s.p.markInteraction();                  // touched at 4:59
  s.fc.advance(2_000);                    // 5:01 since start, 0:02 since touch
  ok(!s.p.isIdle(), 'measured from the last touch, not from the start');
  s.fc.advance(BUDGET - 2_000 - 1);       // 1ms before 5:00 since the touch
  ok(!s.p.isIdle(), 'still present 1ms before five minutes after the touch');
  s.fc.advance(1);
  ok(s.p.isIdle(), 'idle exactly five minutes after the touch');
  ok(s.emits === 1, 'and only announced once', `emits=${s.emits}`);
}

console.log('\nNO TIMER CHURN WHILE SCROLLING');
{
  const s = setup();
  const before = s.fc.armedCount;
  // A thousand touches, one every 100ms — a busy minute and a half of scrolling.
  for (let i = 0; i < 1000; i++) { s.fc.advance(100); s.p.markInteraction(); }
  const rearms = s.fc.armedCount - before;
  ok(rearms <= 1, 'a thousand touches re-arm the timer at most once', `re-arms=${rearms}`);
  ok(!s.p.isIdle() && s.emits === 0, 'and announce nothing while present', `emits=${s.emits}`);
}

console.log('\nCOMING BACK');
{
  const s = setup();
  s.fc.advance(BUDGET);
  ok(s.p.isIdle(), 'idle');
  s.p.markInteraction();
  ok(!s.p.isIdle(), 'one touch brings it back');
  ok(s.emits === 2, 'the return is announced (idle, then back)', `emits=${s.emits}`);
  ok(s.fc.pending === 1, 'and the idle timer is armed again', `pending=${s.fc.pending}`);
  s.p.markInteraction(); s.p.markInteraction();
  ok(s.emits === 2, 'further touches while present announce nothing', `emits=${s.emits}`);
  s.fc.advance(BUDGET);
  ok(s.p.isIdle() && s.emits === 3, 'and it can go idle again later', `emits=${s.emits}`);
}

console.log('\nTIME SINCE TOUCH');
{
  const s = setup();
  s.fc.advance(90_000);
  ok(s.p.msSinceInteraction() === 90_000, 'counts from creation before any touch');
  s.p.markInteraction();
  s.fc.advance(1_234);
  ok(s.p.msSinceInteraction() === 1_234, 'and from the last touch after one');
}

console.log('\nSUBSCRIBERS');
{
  const fc = fakeClock();
  const p = createPresence(BUDGET, fc.clock);
  let a = 0, b = 0;
  const offA = p.subscribe(() => { a++; });
  p.subscribe(() => { throw new Error('bad subscriber'); });
  p.subscribe(() => { b++; });
  fc.advance(BUDGET);
  ok(a === 1 && b === 1, 'a throwing subscriber does not stop the others', `a=${a} b=${b}`);
  offA();
  p.markInteraction();
  ok(a === 1 && b === 2, 'an unsubscribed callback is not called again', `a=${a} b=${b}`);
  // Unsubscribing from inside a callback must not skip the next subscriber.
  const fc2 = fakeClock();
  const p2 = createPresence(BUDGET, fc2.clock);
  let calledSecond = false;
  const offFirst = p2.subscribe(() => { offFirst(); });
  p2.subscribe(() => { calledSecond = true; });
  fc2.advance(BUDGET);
  ok(calledSecond, 'unsubscribing mid-notification does not skip the next subscriber');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
