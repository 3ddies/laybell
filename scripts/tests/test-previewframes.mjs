// Run from the repo root: node scripts/tests/test-previewframes.mjs
// Tests lib/previewFrames.ts — the shipped source, compiled — then checks every
// frame URL the component would request for the real posts. Run from the repo root.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const OUT = join(tmpdir(), 'laybell-tests', 'test-previewframes');
execSync(`npx tsc lib/previewFrames.ts --outDir "${OUT}" --module esnext --target es2022 --skipLibCheck`, { stdio: 'inherit' });
writeFileSync(join(OUT, 'package.json'), '{"type":"module"}');
const { previewFrameTimes: f } = await import(pathToFileURL(join(OUT, 'previewFrames.js')).href);

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got  ${g}\n          want ${w}`); }
};

eq(f(705, null, null, 4), [88, 264, 440, 616], 'the 705s post spreads four moments across the whole video');
eq(f(181, null, null, 4), [22, 67, 113, 158], 'a 181s post');
eq(f(7, null, null, 4), [0, 2, 4, 6], 'a 7s clip still gets four distinct frames');
eq(f(1.5, null, null, 4), [0, 1], 'a very short clip dedupes to the frames that exist');
eq(f(null, null, null, 4), [], 'unknown length shows the poster only — never guesses past the end');
eq(f(0, null, null, 4), [], 'zero length');
eq(f(undefined, 2, 5, 4), [], 'unknown length, even with a trim window');
eq(f(100, 10, 40, 4), [13, 21, 28, 36], 'frames stay inside the trim window');
eq(f(100, 10.6, 20.6, 4), [11, 14, 16, 19], 'a fractional trim start never floors back before it');
eq(f(100, 150, null, 4), [], 'a trim start past the end leaves nothing to show');
eq(f(100, 50, 40, 4), [], 'a trim end before its start leaves nothing to show');
eq(f(100, null, 500, 4), [12, 37, 62, 87], 'a trim end past the duration is clamped to it');
eq(f(100, null, null, 0), [], 'zero frames asked for');

// Stored durations are whole seconds and can run up to a second past the real end
// (705 stored for a 704.6s stream). Every frame must land at or before d-1, which
// is before ANY real length that could have been stored as d.
let late = null;
for (let d = 1; d <= 5000 && !late; d++) {
  const times = f(d, null, null, 4);
  if (times.some((t) => t > d - 1)) late = `d=${d} → ${JSON.stringify(times)}`;
}
eq(late, null, 'no frame is ever later than a second before the stored end (durations 1..5000s)');

console.log(`\n${pass} passed, ${fail} failed`);

// Live: every frame URL the component would request for the real posts must come
// back as an image, not Cloudflare's 400.
const src = readFileSync('lib/supabase.ts', 'utf8');
const url = src.match(/https:\/\/[a-z0-9]+\.supabase\.co/)[0];
const key = src.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)[0];
const rows = await (await fetch(
  `${url}/rest/v1/posts?select=id,media_url,duration_seconds,trim_start,trim_end&type=eq.video&is_public=eq.true&archived_at=is.null&media_url=ilike.*cloudflarestream*`,
  { headers: { apikey: key, Authorization: `Bearer ${key}` } },
)).json();
const HLS = /\/manifest\/video\.m3u8(\?.*)?$/;
let ok = 0, bad = 0, bytes = 0;
for (const p of rows) {
  for (const t of f(p.duration_seconds, p.trim_start, p.trim_end, 4)) {
    // Same shape as lib/cast.cfStreamFrameUrl(url, t, 640).
    const u = p.media_url.replace(HLS, `/thumbnails/thumbnail.jpg?time=${Math.max(0, t).toFixed(2)}s&height=640`);
    const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
    const b = Buffer.from(await r.arrayBuffer());
    if (r.ok && (r.headers.get('content-type') || '').startsWith('image/')) { ok++; bytes += b.length; }
    else { bad++; console.log(`  BAD ${p.id.slice(0, 8)} t=${t}: ${r.status} ${b.toString('utf8').slice(0, 80)}`); }
  }
}
console.log(`live frames: ${ok} ok, ${bad} bad, across ${rows.length} posts; average ${(bytes / Math.max(ok, 1) / 1024).toFixed(0)} KB per frame`);
if (fail || bad) process.exitCode = 1;
