// Generates standalone, hostable HTML versions of the Privacy Policy and Terms
// of Service from the same JSON the app reads (lib/legal/*.json), so the web
// copies never drift from the in-app screens. Re-run after editing the JSON:
//
//   node scripts/build-legal-html.mjs
//
// Output: web/privacy.html, web/terms.html, web/index.html. Upload the `web`
// folder to any static host and point laybell.app/privacy + laybell.app/terms
// at privacy.html + terms.html.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const DOCS = [
  { src: 'lib/legal/privacy.json', out: 'web/privacy.html' },
  { src: 'lib/legal/terms.json', out: 'web/terms.html' },
  { src: 'lib/legal/community.json', out: 'web/community.html' },
  { src: 'lib/legal/advertising.json', out: 'web/advertising.html' },
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const isLastUpdated = (t) => t.trim().toLowerCase().startsWith('last updated');

function renderSections(doc) {
  let out = '';
  for (const sec of doc.sections) {
    out += `<section><h2>${esc(sec.heading)}</h2>`;
    const blocks = sec.blocks.filter((b) => !isLastUpdated(b.text));
    let i = 0;
    while (i < blocks.length) {
      const b = blocks[i];
      if (b.type === 'bullet') {
        let lis = '';
        while (i < blocks.length && blocks[i].type === 'bullet') { lis += `<li>${esc(blocks[i].text)}</li>`; i++; }
        out += `<ul>${lis}</ul>`;
        continue;
      }
      if (b.type === 'subheading') out += `<h3>${esc(b.text)}</h3>`;
      else out += `<p>${esc(b.text)}</p>`;
      i++;
    }
    out += `</section>`;
  }
  return out;
}

const CSS = `
:root { --bg:#faf9f7; --card:#ffffff; --ink:#1b1b1f; --muted:#5e5e66; --line:#e7e4df; --brand:#E8401C; --brand2:#F26522; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
main { max-width:760px; margin:0 auto; padding:40px 22px 80px; }
.back { display:inline-block; margin-bottom:18px; color:var(--brand); text-decoration:none; font-weight:600; font-size:14px; }
.back:hover { text-decoration:underline; }
h1 { font-size:30px; line-height:1.2; margin:0 0 4px; background:linear-gradient(90deg,var(--brand),var(--brand2)); -webkit-background-clip:text; background-clip:text; color:transparent; }
.eff { color:var(--muted); font-size:13px; font-weight:600; margin:0 0 28px; }
section { margin:0 0 26px; }
h2 { font-size:19px; margin:30px 0 8px; padding-bottom:6px; border-bottom:1px solid var(--line); }
h3 { font-size:15px; color:var(--brand); margin:18px 0 6px; }
p { margin:0 0 12px; color:#2b2b30; }
ul { margin:0 0 14px; padding-left:20px; }
li { margin:0 0 7px; color:#2b2b30; }
a { color:var(--brand); }
footer { margin-top:48px; padding-top:18px; border-top:1px solid var(--line); color:var(--muted); font-size:13px; text-align:center; }
@media (max-width:520px){ main{padding:26px 16px 60px;} h1{font-size:25px;} }
`;

function page(doc) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(doc.title)} — Laybell</title>
<style>${CSS}</style>
</head><body><main>
<a class="back" href="./index.html">← Laybell Legal</a>
<h1>${esc(doc.title)}</h1>
<p class="eff">Last Updated: ${esc(doc.effective || '')}</p>
${renderSections(doc)}
<footer>© 2026 Laybell LLC. All rights reserved.</footer>
</main></body></html>`;
}

mkdirSync('web', { recursive: true });
for (const d of DOCS) {
  const doc = JSON.parse(readFileSync(d.src, 'utf8'));
  writeFileSync(d.out, page(doc));
}

const index = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Laybell — Legal</title>
<style>${CSS} .links{display:flex;flex-direction:column;gap:12px;margin-top:24px} .links a{display:block;padding:16px 18px;background:var(--card);border:1px solid var(--line);border-radius:12px;text-decoration:none;color:var(--ink);font-weight:600} .links a:hover{border-color:var(--brand)}</style>
</head><body><main>
<h1>Laybell Legal</h1>
<p class="eff">Laybell LLC · Last Updated: June 13, 2026</p>
<div class="links">
<a href="./privacy.html">Privacy Policy →</a>
<a href="./terms.html">Terms of Service →</a>
<a href="./community.html">Community Guidelines →</a>
<a href="./advertising.html">Advertiser Terms →</a>
</div>
<footer>© 2026 Laybell LLC. All rights reserved.</footer>
</main></body></html>`;
writeFileSync('web/index.html', index);

console.log('Wrote ' + DOCS.length + ' legal pages + web/index.html');
