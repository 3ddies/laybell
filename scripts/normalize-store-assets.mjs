// Forces the two Play graphics into the EXACT PNG shapes Google specifies.
// Run after make-store-assets.ps1 (which calls this automatically).
//
//   Feature graphic — "JPEG or 24-bit PNG (no alpha)"   → colorType 2
//   App icon        — "32-bit PNG (with alpha)"         → colorType 6
//   https://support.google.com/googleplay/android-developer/answer/9866151
//
// These two requirements are OPPOSITE, and they were shipped swapped: the
// feature graphic carried an alpha channel it is not allowed to have, and the
// icon had its alpha stripped on the belief that Play rejects transparency (it
// is the feature graphic that does). Both would have been rejected at upload,
// which is a wasted trip to the console rather than anything visible on screen —
// exactly the sort of thing worth enforcing in code instead of remembering.
//
// Appearance is untouched either way: alpha is added fully opaque, and stripping
// it composites over black, which every pixel here already sits on.

import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** @param {string} rel @param {2|6} colorType */
function normalize(rel, colorType, label) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    console.log(`  SKIP  ${rel} (not built yet)`);
    return false;
  }
  const src = PNG.sync.read(fs.readFileSync(file));
  const out = new PNG({ width: src.width, height: src.height, colorType, inputColorType: 6 });

  for (let i = 0; i < src.data.length; i += 4) {
    const a = src.data[i + 3];
    if (colorType === 2 && a !== 255) {
      // Composite over black rather than letting the channel be dropped raw —
      // a semi-transparent pixel would otherwise brighten unpredictably.
      const f = a / 255;
      out.data[i] = Math.round(src.data[i] * f);
      out.data[i + 1] = Math.round(src.data[i + 1] * f);
      out.data[i + 2] = Math.round(src.data[i + 2] * f);
    } else {
      out.data[i] = src.data[i];
      out.data[i + 1] = src.data[i + 1];
      out.data[i + 2] = src.data[i + 2];
    }
    out.data[i + 3] = 255;
  }

  fs.writeFileSync(file, PNG.sync.write(out, { colorType, inputColorType: 6 }));
  const kb = (fs.statSync(file).size / 1024).toFixed(0);
  console.log(`  OK    ${rel}  ${src.width}x${src.height}  ${label}  ${kb}KB`);
  return true;
}

console.log('Normalising Play graphics to Google\'s stated formats:');
normalize('store/play-feature-graphic.png', 2, '24-bit RGB, no alpha');
normalize('store/play-icon-512.png', 6, '32-bit RGBA, with alpha');

// Screenshots: BOTH stores refuse transparency, so there is no 32-bit case here.
//   Apple — "No alpha channels or transparencies permitted."
//   Play  — "JPEG or 24-bit PNG (no alpha)"
// make-screenshots.ps1 draws through System.Drawing, which can only write 32bpp
// ARGB, so every frame it produces would be rejected without this pass.
const shotDirs = ['store/screenshots/appstore', 'store/screenshots/play', 'store/screenshots/tablet', 'store/screenshots/landscape'];
let shots = 0;
for (const dir of shotDirs) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const f of fs.readdirSync(abs).filter((n) => n.toLowerCase().endsWith('.png')).sort()) {
    if (normalize(path.join(dir, f).replace(/\\/g, '/'), 2, '24-bit RGB, no alpha')) shots++;
  }
}
if (shots) console.log(`  ${shots} screenshot frame(s) flattened.`);
