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

const SITE = 'https://laybell.app';

// The description is written here rather than lifted from the document, because
// a legal document's opening paragraph is a definitions clause and makes a
// useless search result. Each one below is checked against that document's
// actual section headings — do not embellish them.
const DOCS = [
  { src: 'lib/legal/privacy.json', out: 'web/privacy.html', file: 'privacy.html',
    desc: 'How Laybell collects, uses, shares and protects your data — what is public by default, and the choices and rights you have over it.' },
  { src: 'lib/legal/terms.json', out: 'web/terms.html', file: 'terms.html',
    desc: 'The agreement between you and Laybell LLC: who may use Laybell, your content and the licence you grant, payments and subscriptions, and how disputes are resolved.' },
  { src: 'lib/legal/community.json', out: 'web/community.html', file: 'community.html',
    desc: "What is and isn't allowed on Laybell — respecting people, protecting minors, mature content, rights and music, and how reporting and enforcement work." },
  { src: 'lib/legal/advertising.json', out: 'web/advertising.html', file: 'advertising.html',
    desc: 'The rules for advertising on Laybell: who may advertise, billing and refunds, prohibited ad content, targeting limits, and ad review.' },
  { src: 'lib/legal/marketplace.json', out: 'web/marketplace.html', file: 'marketplace.html',
    desc: 'The terms for selling and licensing beats and songs on Laybell — leases, exclusive purchases, free claims, and how payment works.' },
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
:root { --bg:#faf9f7; --card:#ffffff; --ink:#1b1b1f; --body:#2b2b30; --muted:#5e5e66; --line:#e7e4df; --brand:#E8401C; --brand2:#F26522; }
/* These pages are opened from inside a dark app — Settings → Privacy Center
   links straight here — so a light-only page is a white flash mid-session, at
   night, on a phone. Same document, same words, just readable in the dark. The
   brand orange lightens to #F26522 on dark: #E8401C clears AA against #121214
   by a hair (4.6:1) and every link on the page is set in it. */
@media (prefers-color-scheme:dark) {
  :root { --bg:#121214; --card:#1c1c20; --ink:#f4f3f1; --body:#d9d8dd; --muted:#a2a2ab; --line:#2c2c32; --brand:#F26522; --brand2:#FF7A3D; }
}
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
p { margin:0 0 12px; color:var(--body); }
ul { margin:0 0 14px; padding-left:20px; }
li { margin:0 0 7px; color:var(--body); }
a { color:var(--brand); }
footer { margin-top:48px; padding-top:18px; border-top:1px solid var(--line); color:var(--muted); font-size:13px; text-align:center; }
@media (max-width:520px){ main{padding:26px 16px 60px;} h1{font-size:25px;} }
`;

// One head for every page here, so a favicon or a card never lands on four of
// the six. `title` is the bare document name: the JSON titles already begin
// with "Laybell", and appending the brand again gave tabs that read "Laybell
// Privacy Policy — Laybell". Note there is deliberately NO og:site_name —
// Apple strips a leading site name back off og:title when it sees one, which is
// how the app's own share cards ended up reading "Music & Social".
function head({ title, desc, file }) {
  const full = `${esc(title)} — Laybell`;
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${full}</title>
<meta name="description" content="${esc(desc)}">
<link rel="icon" href="./logo.png">
<link rel="apple-touch-icon" href="./logo.png">
<link rel="canonical" href="${SITE}/${file}">
<meta name="theme-color" content="#faf9f7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121214" media="(prefers-color-scheme: dark)">
<meta property="og:title" content="${full}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${SITE}/${file}">
<meta property="og:image" content="${SITE}/logo.png">
<meta property="og:type" content="website">`;
}

const bareTitle = (t) => String(t).replace(/^Laybell\s+/, '');

function page(doc, meta) {
  return `<!doctype html>
<html lang="en"><head>
${head({ title: bareTitle(doc.title), desc: meta.desc, file: meta.file })}
<style>${CSS}</style>
</head><body><main>
<a class="back" href="./legal.html">← Laybell Legal</a>
<h1>${esc(doc.title)}</h1>
<p class="eff">Last Updated: ${esc(doc.effective || '')}</p>
${renderSections(doc)}
<footer>© 2026 Laybell LLC. All rights reserved.</footer>
</main></body></html>`;
}

mkdirSync('web', { recursive: true });
for (const d of DOCS) {
  const doc = JSON.parse(readFileSync(d.src, 'utf8'));
  writeFileSync(d.out, page(doc, d));
}

const index = `<!doctype html>
<html lang="en"><head>
${head({ title: 'Legal', desc: "Laybell's policies in one place: privacy, terms of service, community guidelines, advertiser terms, and marketplace and beat licensing.", file: 'legal.html' })}
<style>${CSS} .links{display:flex;flex-direction:column;gap:12px;margin-top:24px} .links a{display:block;padding:16px 18px;background:var(--card);border:1px solid var(--line);border-radius:12px;text-decoration:none;color:var(--ink);font-weight:600} .links a:hover{border-color:var(--brand)}</style>
</head><body><main>
<h1>Laybell Legal</h1>
<p class="eff">Laybell LLC · Last Updated: June 25, 2026</p>
<div class="links">
<a href="./privacy.html">Privacy Policy →</a>
<a href="./terms.html">Terms of Service →</a>
<a href="./community.html">Community Guidelines →</a>
<a href="./advertising.html">Advertiser Terms →</a>
<a href="./marketplace.html">Marketplace &amp; Beat Licensing Terms →</a>
<a href="./delete-account.html">Delete Your Account →</a>
</div>
<footer>© 2026 Laybell LLC. All rights reserved.</footer>
</main></body></html>`;
// legal.html, NOT index.html: index.html is the company landing page and is
// hand-written. Overwriting it here would replace the site with a list of legal
// documents — which is what Apple's organization verification would then see.
writeFileSync('web/legal.html', index);

console.log('Wrote ' + DOCS.length + ' legal pages + web/legal.html');
