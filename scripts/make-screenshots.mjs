// Premium store-screenshot renderer — the "Midnight" redesign (2026-10-28).
//
//   node scripts/make-screenshots.mjs
//
// Supersedes make-screenshots.ps1's GDI+ framing with an HTML -> headless-Chrome
// pipeline, which buys real CSS: a titanium device bezel, the Bricolage Grotesque
// display font, a soft brand glow and true blur/shadows. Same job, far more polish.
//
// IN   store/screenshots/raw/   the phone captures named in FRAMES below
// OUT  store/screenshots/appstore/  1320x2868  (Apple 6.9", covers every iPhone)
//      store/screenshots/play/      1080x1920  (Play phone, exactly 9:16)
//      store/screenshots/tablet/    1440x2560  (Play 7in + 10in tablet)
//
// FRAMES is the single source of truth for WHICH captures ship, in WHAT ORDER,
// with WHICH caption. Pairing caption to raw by name (not by position) means a
// frame can be dropped or reordered without silently mislabelling the rest — the
// trap make-screenshots.ps1's positional CAPTIONS array warns about. Output is
// renumbered 01..0N in list order, so each store folder uploads in filename order.
//
// The "Begging cat type beat" shop capture (raw/06.png) is deliberately NOT in the
// list: it is joke test content and undersells the Sell-beats feature. Re-add it
// with a real listing capture (real art, title, price) when one exists — see
// docs/STORE_SCREENSHOTS_1.0.1.md for the capture rules.
//
// Captions carry an <span class="accent"> on the key phrase, which renders as the
// brand gradient. Keep the accent on a SINGLE visual line (don't let a <br> fall
// inside it) or the gradient resets mid-phrase.
//
// No alpha, either store (Apple + Play both reject it). Chrome writes RGBA, so the
// repo's normalize-store-assets.mjs is run at the end to flatten every frame over
// black — which is a no-op on colour here, the ground already being near-black.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const RAW = path.join(ROOT, 'store', 'screenshots', 'raw');

// ── The set. Edit here to add / drop / reorder a frame. ──────────────────────
const FRAMES = [
  { raw: '01.png', html: '<span class="accent">Albums and singles</span>,<br>not just posts.' },
  { raw: '02.png', html: 'A whole shelf of<br><span class="accent">films</span>.' },
  { raw: '03.png', html: '<span class="accent">Real songs</span>. Not<br>fifteen-second clips.' },
  { raw: '04.png', html: 'A player built<br><span class="accent">for listening</span>.' },
  { raw: '05.png', html: 'Go live. <span class="accent">Get tipped</span><br>in real time.' },
  // 06 shop — OMITTED until a real beat listing is captured (see header).
  { raw: '07.jpg', html: 'Your earnings,<br>in <span class="accent">one wallet</span>.' },
  { raw: '08.png', html: 'A <span class="accent">real catalogue</span>,<br>not a feed.' },
];

const SIZES = [
  { dir: 'appstore', w: 1320, h: 2868 },
  { dir: 'play', w: 1080, h: 1920 },
  { dir: 'tablet', w: 1440, h: 2560 },
];

function findChrome() {
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.CHROME_PATH,
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('Chrome not found. Set CHROME_PATH to chrome.exe. (Edge headless --screenshot is disabled on this machine — use Chrome.)');
}

// file:// URL for a local path, forward-slashed and space-encoded.
const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/ /g, '%20');

function pageHtml({ imgUrl, capHtml, w, h }) {
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800&display=block" rel="stylesheet">
<style>
:root{--brand:#F26522;--brand-dark:#E8401C;--brand-light:#FAB525;--obsidian:#040406;
--imgW:980px;--bezel:16px;--rOuter:100px;--rInner:84px;--cap:96px;--lh:102px;--capW:1130px;--glowSz:1260px;}
*{margin:0;padding:0;box-sizing:border-box;}
html,body{overflow:hidden;background:var(--obsidian);width:${w}px;height:${h}px;}
.frame{position:relative;width:${w}px;height:${h}px;display:flex;flex-direction:column;align-items:center;overflow:hidden;
background:radial-gradient(130% 80% at 50% -8%,#171013 0%,#090709 42%,var(--obsidian) 100%);}
.cap{width:var(--capW);text-align:center;color:#F7F7F8;font-family:"Bricolage Grotesque",system-ui,sans-serif;
font-weight:800;font-size:var(--cap);line-height:var(--lh);letter-spacing:-0.022em;z-index:3;}
.cap .accent{background:linear-gradient(100deg,var(--brand-light),var(--brand) 55%,var(--brand-dark));
-webkit-background-clip:text;background-clip:text;color:transparent;}
.stage{position:relative;flex:1;width:100%;display:flex;align-items:center;justify-content:center;}
.glow{position:absolute;left:50%;top:50%;width:var(--glowSz);height:var(--glowSz);transform:translate(-50%,-50%);
background:radial-gradient(circle,rgba(242,101,34,.40),rgba(232,64,28,.13) 44%,transparent 70%);filter:blur(44px);z-index:1;}
.phone{position:relative;z-index:2;padding:var(--bezel);border-radius:var(--rOuter);
background:linear-gradient(142deg,#5a5a5f 0%,#18181b 24%,#0c0c0e 52%,#161619 78%,#4c4c51 100%);
box-shadow:0 70px 130px -34px rgba(0,0,0,.62),0 14px 38px rgba(0,0,0,.40);}
.screen{position:relative;border-radius:var(--rInner);overflow:hidden;border:3px solid #000;background:#000;display:block;line-height:0;}
.screen img{width:var(--imgW);height:auto;display:block;}
.grain{position:absolute;inset:0;z-index:4;pointer-events:none;opacity:.20;mix-blend-mode:overlay;
background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>");}
</style></head><body>
<div class="frame"><h1 class="cap">${capHtml}</h1>
<div class="stage"><div class="glow"></div><div class="phone"><div class="screen"><img id="shot" alt=""></div></div></div>
<div class="grain"></div></div>
<script>
var W=${w},H=${h},s=W/1320,R=document.documentElement.style,cap=document.querySelector('.cap'),img=document.getElementById('shot');
R.setProperty('--capW',(W-Math.round(190*s))+'px');
cap.style.marginTop=Math.round(150*s)+'px';
function layout(){
  var size=Math.round(96*s),min=Math.round(58*s);
  while(size>min){R.setProperty('--cap',size+'px');R.setProperty('--lh',Math.round(size*1.06)+'px');
    if(cap.scrollWidth<=cap.clientWidth+1)break;size-=2;}
  var stage=document.querySelector('.stage'),ar=img.naturalWidth/img.naturalHeight||0.461;
  var availW=W-2*Math.round(108*s),availH=stage.clientHeight-Math.round(120*s),bz=0.016;
  var imgW=Math.min(availW/(1+2*bz),availH/(1/ar+2*bz)),bezel=Math.max(9,imgW*bz),rOuter=imgW*0.102;
  R.setProperty('--imgW',Math.round(imgW)+'px');R.setProperty('--bezel',Math.round(bezel)+'px');
  R.setProperty('--rOuter',Math.round(rOuter)+'px');R.setProperty('--rInner',Math.max(2,Math.round(rOuter-bezel))+'px');
  R.setProperty('--glowSz',Math.round(imgW*1.28)+'px');document.title='ready';
}
function go(){document.fonts&&document.fonts.ready?document.fonts.ready.then(layout):layout();}
img.complete?go():img.onload=go;img.src=${JSON.stringify(imgUrl)};
</script></body></html>`;
}

const CHROME = findChrome();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lbshots-'));
// Clear each output dir of stale numbered frames first, so a shorter set never
// leaves an old-design frame behind (e.g. a dropped frame 08) to be uploaded.
for (const s of SIZES) {
  const dir = path.join(ROOT, 'store', 'screenshots', s.dir);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (/^\d\d\.png$/.test(f)) fs.rmSync(path.join(dir, f));
}

console.log(`Rendering ${FRAMES.length} frame(s) x ${SIZES.length} size(s) with the Midnight design...`);
let count = 0;
for (let i = 0; i < FRAMES.length; i++) {
  const f = FRAMES[i];
  const rawPath = path.join(RAW, f.raw);
  if (!fs.existsSync(rawPath)) { console.log(`  MISSING raw/${f.raw} — skipped`); continue; }
  const n = String(i + 1).padStart(2, '0');
  const imgUrl = fileUrl(rawPath);
  for (const size of SIZES) {
    const htmlPath = path.join(tmp, `f${n}-${size.dir}.html`);
    fs.writeFileSync(htmlPath, pageHtml({ imgUrl, capHtml: f.html, w: size.w, h: size.h }));
    const out = path.join(ROOT, 'store', 'screenshots', size.dir, `${n}.png`);
    execFileSync(CHROME, [
      '--headless=old', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=1', `--user-data-dir=${path.join(tmp, 'cud')}`,
      '--virtual-time-budget=4500', `--screenshot=${out}`,
      `--window-size=${size.w},${size.h}`, fileUrl(htmlPath),
    ], { stdio: 'ignore' });
    count++;
  }
  console.log(`  ${n}  raw/${f.raw}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Rendered ${count} frame file(s).`);

// Flatten alpha (both stores reject it). Reuses the repo normaliser.
console.log('Flattening alpha for store upload:');
const norm = spawnSync('node', [path.join(ROOT, 'scripts', 'normalize-store-assets.mjs')], { stdio: 'inherit' });
process.exit(norm.status || 0);
