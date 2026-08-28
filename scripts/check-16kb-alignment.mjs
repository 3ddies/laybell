// Verify every native library in an Android build supports Google Play's 16 KB
// memory page-size requirement.
//
// WHY THIS EXISTS. Play flagged bundle 4 at submission on 2026-08-21 and let us
// bypass it with "Proceed anyway". The advice in the console — and in our own
// backlog — was "rebuild with updated native libraries and test on a 16 KB
// device". That framing is what made it look like a blocked task: we do not have
// an Android device.
//
// It did not need one. The answer is sitting in the binary. Every shared library
// declares the page alignment it was linked for in its ELF program headers, so
// reading the AAB tells you exactly which libraries fail and which are fine. On
// build 4 that turned out to be 39 libraries correct and ONE wrong, and the one
// belonged to a feature that had already been switched off.
//
// Prefer this over trusting a device: a device tells you whether the app happened
// to crash on the paths you exercised. This tells you which libraries are wrong.
//
// USAGE
//   1. Get the .aab — from EAS:
//        npx eas-cli build:list --platform android --limit 1 --json --non-interactive
//      then download the artifacts.applicationArchiveUrl. (Artifacts expire after
//      about 30 days; for an older build, rebuild instead.)
//   2. Unzip the ABI you care about and run this on it:
//        unzip -qo app.aab 'base/lib/arm64-v8a/*' -d out
//        node scripts/check-16kb-alignment.mjs out/base/lib/arm64-v8a
//
// Check BOTH 64-bit ABIs — arm64-v8a and x86_64. The 32-bit ones (armeabi-v7a,
// x86) are not subject to the requirement.
//
// Exits non-zero if anything is misaligned, so it can gate a release step.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REQUIRED = 16384; // 16 KB. The old default was 4096, and 4096 is the failure.
const PT_LOAD = 1;

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/check-16kb-alignment.mjs <dir-of-.so-files>');
  process.exit(2);
}

/** Largest PT_LOAD p_align in an ELF64 shared object; 0 if unreadable. */
function maxLoadAlign(buf) {
  if (buf.length < 64) return 0;
  if (buf.readUInt32BE(0) !== 0x7f454c46) return 0; // not ELF
  if (buf[4] !== 2) return 0; // not 64-bit — not subject to the requirement
  const phoff = Number(buf.readBigUInt64LE(0x20));
  const phentsize = buf.readUInt16LE(0x36);
  const phnum = buf.readUInt16LE(0x38);
  let max = 0;
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    if (o + 56 > buf.length) break;
    if (buf.readUInt32LE(o) !== PT_LOAD) continue;
    const align = Number(buf.readBigUInt64LE(o + 48)); // p_align
    if (align > max) max = align;
  }
  return max;
}

const libs = readdirSync(dir).filter((n) => n.endsWith('.so')).sort();
if (!libs.length) {
  console.error(`no .so files in ${dir} — wrong directory?`);
  process.exit(2);
}

const bad = [];
const pad = Math.max(...libs.map((n) => n.length));
for (const name of libs) {
  const align = maxLoadAlign(readFileSync(join(dir, name)));
  const ok = align >= REQUIRED;
  if (!ok) bad.push({ name, align });
  console.log(`${ok ? '  ok  ' : '  ****'} ${name.padEnd(pad)}  align=${align} (${align / 1024}K)`);
}

console.log(`\n${libs.length} libraries checked, ${bad.length} misaligned.`);
if (bad.length) {
  for (const { name, align } of bad) console.log(`  - ${name} (${align / 1024}K)`);
  console.log(
    '\nTo find the source of a bad library: grep node_modules/*/android/build.gradle\n'
    + 'for the Gradle coordinate that ships it, then check whether a newer release\n'
    + 'exists. If upstream is dead — as video.api:rtmpdroid was — the real question\n'
    + 'is whether the feature is still worth carrying.',
  );
  process.exit(1);
}
console.log('All 64-bit libraries meet the 16 KB page-size requirement.');
