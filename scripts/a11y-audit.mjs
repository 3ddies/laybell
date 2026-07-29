// Accessibility audit: finds icon-only buttons that announce nothing to a screen
// reader. A touchable wrapping <Text> is auto-labelled by that text, so it is not
// the problem — these are. Run: node scripts/a11y-audit.mjs
//
// Use the count as a progress metric; it should fall over time, never rise.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Find touchables whose only child is an icon. Those announce NOTHING to a screen
// reader — a button wrapping <Text> is auto-labelled by that text, so it is not
// the problem. This is the set worth fixing.
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(e)) out.push(p);
  }
  return out;
}

const files = [...walk('app'), ...walk('components')];
const hits = [];

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  // Match a touchable open tag through its close tag, non-greedy.
  const re = /<(TouchableOpacity|Pressable|TouchableHighlight)([^>]*?)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const attrs = m[2];
    const body = m[3];
    if (/accessibilityLabel/.test(attrs)) continue;
    const hasIcon = /<Ionicons|<MaterialIcons|<Feather|<FontAwesome/.test(body);
    const hasText = /<Text[\s>]/.test(body);
    if (hasIcon && !hasText) {
      const line = src.slice(0, m.index).split('\n').length;
      const icon = (body.match(/name=["']([^"']+)["']/) || [])[1] || '?';
      hits.push({ file: f.replace(/\\/g, '/'), line, icon });
    }
  }
}

const byFile = {};
for (const h of hits) (byFile[h.file] ||= []).push(h);

console.log(`icon-only touchables with no accessibilityLabel: ${hits.length}\n`);
Object.entries(byFile)
  .sort((a, b) => b[1].length - a[1].length)
  .slice(0, 15)
  .forEach(([f, list]) => {
    console.log(`${String(list.length).padStart(3)}  ${f}`);
    console.log(`     ${[...new Set(list.map((h) => h.icon))].slice(0, 8).join(', ')}`);
  });
