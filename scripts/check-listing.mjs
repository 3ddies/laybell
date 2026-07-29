import { readFileSync } from 'node:fs';

// Verify every store-listing field fits its limit.
//
// The stores enforce these silently — App Store Connect just truncates or
// refuses to save, usually while you're doing six other things — and the limits
// are counted in ways that are easy to get wrong by hand (the keywords field
// counts the commas, and a space after a comma costs you a character you could
// have spent on a keyword).
//
// Rather than keep a second copy of the copy in this script, where it would
// drift from the doc within a week, this reads the doc: any heading of the form
// "### <field> — max <N>" is checked against the fenced block directly beneath
// it. Keep that shape and new fields are covered automatically.

const DOC = new URL('../docs/STORE_LISTING.md', import.meta.url);
const src = readFileSync(DOC, 'utf8');
const lines = src.split(/\r?\n/);

const fields = [];
for (let i = 0; i < lines.length; i++) {
  const m = /^#{2,4}\s+(.+?)\s+[—-]\s*max\s+([\d,]+)/i.exec(lines[i]);
  if (!m) continue;
  const [, name, limitRaw] = m;
  const limit = Number(limitRaw.replace(/,/g, ''));

  // Find the first fence after the heading, but give up if another heading
  // arrives first — that means this field documents prose, not a literal value.
  let j = i + 1;
  while (j < lines.length && !lines[j].startsWith('```') && !/^#{2,4}\s/.test(lines[j])) j++;
  if (j >= lines.length || !lines[j].startsWith('```')) continue;

  const body = [];
  for (j++; j < lines.length && !lines[j].startsWith('```'); j++) body.push(lines[j]);
  fields.push({ name, limit, value: body.join('\n').trim() });
}

if (!fields.length) {
  console.error('no fields found — has the doc structure changed?');
  process.exit(1);
}

let failed = 0;
const pad = Math.max(...fields.map((f) => f.name.length));

for (const f of fields) {
  const n = [...f.value].length;              // code points, not UTF-16 units
  const over = n > f.limit;
  if (over) failed++;
  const bar = over ? 'OVER ' : 'ok   ';
  console.log(`${bar} ${f.name.padEnd(pad)}  ${String(n).padStart(4)} / ${f.limit}`);

  // The keywords field is the one with a non-obvious rule.
  if (/keyword/i.test(f.name)) {
    const spaces = (f.value.match(/,\s/g) ?? []).length;
    if (spaces) console.log(`       ^ ${spaces} space(s) after commas — each wastes a character`);
    const terms = f.value.split(',').filter(Boolean);
    const dupes = terms.filter((t, i) => terms.indexOf(t) !== i);
    if (dupes.length) console.log(`       ^ duplicate terms: ${[...new Set(dupes)].join(', ')}`);
    console.log(`       ^ ${terms.length} keywords`);
  }
}

console.log(failed ? `\n${failed} field(s) over limit.` : '\nAll fields within limits.');
process.exit(failed ? 1 : 0);
