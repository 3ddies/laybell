// Run from the repo root: node scripts/tests/test-schedule.mjs
// Tests lib/schedule.ts — the shipped source, compiled. Run from the repo root.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const OUT = join(tmpdir(), 'laybell-tests', 'test-schedule');
execSync(`npx tsc lib/schedule.ts --outDir "${OUT}" --module esnext --target es2022 --skipLibCheck`, { stdio: 'inherit' });
writeFileSync(join(OUT, 'package.json'), '{"type":"module"}');
const S = await import(pathToFileURL(join(OUT, 'schedule.js')).href);

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got  ${g}\n          want ${w}`); }
};
const at = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, mo, d, h, mi, s, ms).getTime();
const hm = (ts) => { const d = new Date(ts); return [d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]; };
const MIN = 60_000;

console.log('\nceilToStep / earliestSchedule / defaultSchedule');
eq(hm(S.ceilToStep(at(2026, 8, 11, 14, 2, 30))), [11, 14, 5, 0], 'a partial minute rounds up to the next 5-minute mark');
eq(hm(S.ceilToStep(at(2026, 8, 11, 14, 5))), [11, 14, 5, 0], 'a time already on the grid stays');
eq(hm(S.ceilToStep(at(2026, 8, 11, 14, 55, 1))), [11, 15, 0, 0], 'rolls into the next hour');
eq(hm(S.ceilToStep(at(2026, 8, 11, 23, 58))), [12, 0, 0, 0], 'rolls into the next day');
eq(hm(S.earliestSchedule(at(2026, 8, 11, 14, 2, 30))), [11, 14, 15, 0], 'earliest = ten minutes out, on the grid');
eq(hm(S.defaultSchedule(at(2026, 8, 11, 14, 2))), [11, 16, 0, 0], 'suggestion = the next whole hour at least an hour away');
eq(hm(S.defaultSchedule(at(2026, 8, 11, 14, 0))), [11, 15, 0, 0], 'exactly on the hour suggests one hour later');

console.log('\nscheduleProblem');
const now = at(2026, 8, 11, 14, 0);
eq(S.scheduleProblem(now + 30_000, now), 'soon', 'under a minute away is too soon');
eq(S.scheduleProblem(now - MIN, now), 'soon', 'the past is too soon');
eq(S.scheduleProblem(now + 2 * MIN, now), null, 'two minutes away is fine');
eq(S.scheduleProblem(now + 30 * 24 * 60 * MIN, now), null, 'exactly 30 days is fine');
eq(S.scheduleProblem(now + 30 * 24 * 60 * MIN + MIN, now), 'far', 'past 30 days is too far');
eq(S.scheduleProblem(NaN, now), 'soon', 'not a time is never accepted');

console.log('\nscheduleDays / dayWord');
{
  const days = S.scheduleDays(at(2026, 8, 11, 23, 30));
  eq(days.length, 31, 'today plus 30 days');
  eq(days[0], at(2026, 8, 11), 'starts at today\'s midnight');
  eq(days.every((d) => { const x = new Date(d); return x.getHours() === 0 && x.getMinutes() === 0; }), true, 'every entry is a local midnight');
  eq(days.slice(1).every((d, i) => { const gap = (d - days[i]) / 3_600_000; return gap >= 23 && gap <= 25; }), true, 'consecutive days, a clock change included');
  // A span across a clock change in most northern-hemisphere zones (early November).
  const fall = S.scheduleDays(at(2026, 10, 1, 9));
  eq(new Set(fall.map((d) => new Date(d).getDate() + '-' + new Date(d).getMonth())).size, 31, 'no date repeats or goes missing across a clock change');
}
eq(S.dayWord(at(2026, 8, 11, 23, 59), at(2026, 8, 11, 0, 1)), 'today', 'later today');
eq(S.dayWord(at(2026, 8, 12, 0, 0), at(2026, 8, 11, 23, 59)), 'tomorrow', 'just past midnight is tomorrow');
eq(S.dayWord(at(2026, 8, 13, 9), at(2026, 8, 11, 9)), null, 'further out has no word');

console.log('\nformatSchedule / uses12h / to12h');
{
  const words = { today: 'Today', tomorrow: 'Tomorrow', dayTime: (d, t) => `${d}, ${t}` };
  const clean = (s) => s.replace(/[\u202f\u00a0]/g, ' ');
  eq(clean(S.formatSchedule(at(2026, 8, 11, 15, 0), at(2026, 8, 11, 9), 'en-US', words)), 'Today, 3:00 PM', 'today');
  eq(clean(S.formatSchedule(at(2026, 8, 12, 9, 30), at(2026, 8, 11, 9), 'en-US', words)), 'Tomorrow, 9:30 AM', 'tomorrow');
  eq(clean(S.formatSchedule(at(2026, 8, 15, 15, 0), at(2026, 8, 11, 9), 'en-US', words)), 'Tue, Sep 15, 3:00 PM', 'a later day names its date');
  eq(clean(S.formatSchedule(at(2026, 8, 12, 15, 0), at(2026, 8, 11, 9), 'de-DE', { ...words, tomorrow: 'Morgen' })), 'Morgen, 15:00', 'German reads 24-hour');
}
eq([S.uses12h('en-US'), S.uses12h('de-DE'), S.uses12h('ja-JP')], [true, false, false], '12-hour only where the language uses it');
eq([0, 11, 12, 13, 23].map((h) => S.to12h(h)), [
  { hour12: 12, pm: false }, { hour12: 11, pm: false }, { hour12: 12, pm: true }, { hour12: 1, pm: true }, { hour12: 11, pm: true },
], 'to12h');
eq(Array.from({ length: 24 }, (_, h) => { const x = S.to12h(h); return S.from12h(x.hour12, x.pm); }), Array.from({ length: 24 }, (_, h) => h), 'every hour survives a round trip');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
