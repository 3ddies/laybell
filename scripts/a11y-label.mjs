import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';

const traverse = _traverse.default ?? _traverse;

// Add accessibilityRole/accessibilityLabel to icon-only touchables.
//
// WHY THIS IS A PARSER AND NOT A REGEX: a previous attempt matched JSX
// attributes with a regex that stopped at the first '>'. Inside
// `onPress={() => foo}` the first '>' is the arrow, so the label landed in the
// middle of the expression and corrupted 89 files. JSX is not a regular
// language; the only safe way to find an attribute list's boundary is to parse.
//
// It still doesn't PRINT from the AST — @babel/generator would reformat every
// file it touches, burying a two-attribute change in a whole-file diff. Instead
// the AST is used purely to compute byte offsets, and those offsets are spliced
// into the ORIGINAL source, highest offset first so earlier ones stay valid.
// The result is a diff containing only the inserted attributes.

const TOUCHABLES = new Set([
  'TouchableOpacity', 'Pressable', 'TouchableHighlight',
  'TouchableWithoutFeedback', 'TouchableNativeFeedback',
]);

const ICON_LIBS = /^(Ionicons|MaterialIcons|MaterialCommunityIcons|FontAwesome\d?|Feather|AntDesign|Entypo|Octicons|SimpleLineIcons|Fontisto)$/;

// icon name -> i18n key under the a11y.* namespace.
//
// Deliberately conservative. An icon whose meaning depends on context (a bare
// 'add', 'checkmark' or 'ellipsis-horizontal' means something different on every
// screen) still gets a generic-but-true label, because "Add" read aloud is
// vastly better than VoiceOver announcing the raw word "button". Icons NOT in
// this map are skipped and reported, never guessed.
const ICON_KEYS = {
  // navigation
  'chevron-back': 'back',
  'arrow-back': 'back',
  'chevron-forward': 'forward',
  'arrow-forward': 'forward',
  'chevron-up': 'moveUp',
  'chevron-down': 'moveDown',
  'close': 'close',
  'close-outline': 'close',
  'close-circle': 'clear',
  'exit-outline': 'leave',
  'log-out-outline': 'leave',
  'expand': 'expand',
  'contract': 'collapse',

  // playback
  'play': 'play',
  'play-circle': 'play',
  'pause': 'pause',
  'pause-circle': 'pause',
  'play-skip-back': 'previousTrack',
  'play-skip-forward': 'nextTrack',
  'play-back': 'rewind',
  'play-forward': 'fastForward',
  'volume-high': 'unmute',
  'volume-mute': 'mute',
  'volume-off': 'mute',
  'hourglass': 'buffering',
  'musical-notes': 'music',
  'musical-note': 'music',
  'repeat': 'repeat',
  'shuffle': 'shuffle',

  // actions
  'add': 'add',
  'add-circle': 'add',
  'add-outline': 'add',
  'remove': 'remove',
  'remove-circle': 'remove',
  'trash': 'delete',
  'trash-outline': 'delete',
  'checkmark': 'confirm',
  'checkmark-circle': 'confirm',
  'copy': 'copy',
  'copy-outline': 'copy',
  'share-outline': 'share',
  'share-social-outline': 'share',
  'arrow-up': 'send',
  'send': 'send',
  'refresh': 'retry',
  'reload': 'retry',
  'search': 'search',
  'search-outline': 'search',
  'create-outline': 'newMessage',
  'pencil': 'edit',
  'ellipsis-horizontal': 'moreOptions',
  'ellipsis-vertical': 'moreOptions',
  'options-outline': 'options',
  'filter': 'filter',

  // media / capture
  'camera': 'camera',
  'camera-outline': 'camera',
  'camera-reverse': 'flipCamera',
  'swap-horizontal': 'flipCamera',
  'image-outline': 'chooseFromLibrary',
  'images-outline': 'chooseFromLibrary',
  'grid-outline': 'grid',
  'color-fill-outline': 'colour',
  'text': 'addText',
  'crop': 'crop',
  'cut-outline': 'trim',

  // social / people
  'people': 'people',
  'people-outline': 'people',
  'person-add': 'addPeople',
  'person-add-outline': 'addPeople',
  'person-outline': 'profile',
  'person': 'profile',
  'add-circle-outline': 'add',
  'mic-outline': 'mic',
  'heart': 'like',
  'heart-outline': 'like',
  'chatbubble-outline': 'comment',
  'chatbubble-ellipses-outline': 'comment',
  'bookmark': 'save',
  'bookmark-outline': 'save',
  'notifications-outline': 'notifications',

  // app-specific
  'settings-outline': 'settings',
  'qr-code-outline': 'qrCode',
  'megaphone': 'announcement',
  'megaphone-outline': 'announcement',
  'tv': 'tv',
  'tv-outline': 'tv',
  'cash-outline': 'tip',
  'card-outline': 'payment',
  'information-circle-outline': 'moreInfo',
  'help-circle-outline': 'help',
  'lock-closed-outline': 'locked',
  'eye-outline': 'show',
  'eye-off-outline': 'hide',
  'star': 'favourite',
  'star-outline': 'favourite',
  'flag-outline': 'report',
};

// ── State-dependent icons ───────────────────────────────────────────────────
// An icon written as `cond ? 'pause' : 'play'` was previously skipped as a
// "dynamic icon name", which left the app's most important buttons — mute,
// like, play/pause, password visibility — announcing as a bare "button". They
// were skipped for a good reason: one label cannot describe two states.
//
// The answer is a label that is ALSO a ternary, reusing the component's own
// condition verbatim so the two can never disagree:
//
//   <Ionicons name={muted ? 'volume-mute' : 'volume-high'} />
//   → accessibilityLabel={muted ? t('a11y.unmute') : t('a11y.mute')}
//
// Note the inversion. The icon shows the CURRENT state; the label must describe
// the ACTION the button performs, which is the opposite. A muted button shows a
// crossed-out speaker and its job is to unmute.
//
// Keyed "consequentIcon|alternateIcon" → [consequentKey, alternateKey].
const DYNAMIC_PAIRS = {
  'volume-mute|volume-high': ['unmute', 'mute'],
  'volume-high|volume-mute': ['mute', 'unmute'],
  'pause|play': ['pause', 'play'],
  'play|pause': ['play', 'pause'],
  'pause-circle|play-circle': ['pause', 'play'],
  'play-circle|pause-circle': ['play', 'pause'],
  'heart|heart-outline': ['unlike', 'like'],
  'heart-outline|heart': ['like', 'unlike'],
  'bookmark|bookmark-outline': ['unsave', 'save'],
  'bookmark-outline|bookmark': ['save', 'unsave'],
  'eye-off-outline|eye-outline': ['hidePassword', 'showPassword'],
  'eye-outline|eye-off-outline': ['showPassword', 'hidePassword'],
  'mic-off|mic': ['unmuteMic', 'muteMic'],
  'mic|mic-off': ['muteMic', 'unmuteMic'],
  'checkmark-circle|ellipse-outline': ['deselect', 'select'],
  'ellipse-outline|checkmark-circle': ['select', 'deselect'],
  'close|chevron-back': ['close', 'back'],
  'chevron-back|close': ['back', 'close'],
};

// Icon pairs that indicate CONTENT TYPE rather than button state — a grid tile
// showing a music note or a video camera depending on what the post is. The
// button does the same thing either way, so both branches get one constant
// label and no ternary is emitted.
const DYNAMIC_SAME = {
  'musical-notes|videocam': 'openPost',
  'videocam|musical-notes': 'openPost',
};

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.tsx')) out.push(p);
  }
  return out;
}

function jsxName(node) {
  if (!node) return null;
  if (node.type === 'JSXIdentifier') return node.name;
  if (node.type === 'JSXMemberExpression') return jsxName(node.property);
  return null;
}

function attr(opening, name) {
  return opening.attributes.find(
    (a) => a.type === 'JSXAttribute' && a.name?.name === name,
  );
}

// Icon-only means: no rendered text anywhere inside. A touchable containing a
// <Text> already announces that text, so labelling it would make VoiceOver read
// the label INSTEAD of the visible words — actively worse than doing nothing.
function scanChildren(node, found = { icons: [], hasText: false }) {
  for (const child of node.children ?? []) {
    if (child.type === 'JSXText' && child.value.trim()) found.hasText = true;
    if (child.type === 'JSXExpressionContainer') {
      // A `{foo}` child may render anything at all. Treat it as text unless it
      // is plainly just a nested element or a comment.
      const e = child.expression;
      if (e.type !== 'JSXElement' && e.type !== 'JSXEmptyExpression') found.hasText = true;
      if (e.type === 'JSXElement') scanChildren(e, found);
    }
    if (child.type === 'JSXElement') {
      const n = jsxName(child.openingElement.name);
      if (n === 'Text' || n === 'AppText') found.hasText = true;
      if (n && ICON_LIBS.test(n)) {
        const a = attr(child.openingElement, 'name');
          // A ternary between two string literals is kept as a node rather
          // than collapsed to null, so the caller can build a matching ternary
          // label. Anything else stays null and is still skipped.
          const v = a?.value;
          if (v?.type === 'StringLiteral') found.icons.push(v.value);
          else if (
            v?.type === 'JSXExpressionContainer' &&
            v.expression.type === 'ConditionalExpression' &&
            v.expression.consequent.type === 'StringLiteral' &&
            v.expression.alternate.type === 'StringLiteral'
          ) found.icons.push({ cond: v.expression });
          else found.icons.push(null);
      }
      scanChildren(child, found);
    }
  }
  return found;
}

// `t` must be the translate function, not just any binding called `t`. This
// codebase has `const t = setTimeout(...)` inside effects, and inserting
// `t('a11y.close')` where `t` is a Timeout would compile but crash at runtime.
function hasTranslate(path) {
  const binding = path.scope.getBinding('t');
  if (!binding) return false;
  const decl = binding.path.node;
  return (
    decl.type === 'VariableDeclarator' &&
    decl.init?.type === 'CallExpression' &&
    decl.init.callee?.name === 'useTranslation'
  );
}

const apply = process.argv.includes('--apply');
const files = [...walk('app'), ...walk('components')];

let inserted = 0;
let filesChanged = 0;
const skipped = new Map(); // reason -> count
const unmapped = new Map(); // icon -> count
const usedKeys = new Set();
const noTranslate = new Set();

function skip(reason) {
  skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
}

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  let ast;
  try {
    ast = parse(src, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: false,
    });
  } catch (err) {
    console.error(`PARSE FAIL ${file}: ${err.message}`);
    continue;
  }

  const edits = [];

  traverse(ast, {
    JSXElement(path) {
      const opening = path.node.openingElement;
      const name = jsxName(opening.name);
      if (!TOUCHABLES.has(name)) return;
      if (attr(opening, 'accessibilityLabel')) return;         // already done
      if (!attr(opening, 'onPress') && !attr(opening, 'onLongPress')) return;

      const { icons, hasText } = scanChildren(path.node);
      if (hasText) return skip('has visible text');
      if (icons.length === 0) return skip('no icon child');
      if (icons.some((i) => i === null)) return skip('dynamic icon name');

      // ── The state-dependent case ──────────────────────────────────────
      // Exactly one icon, written as `cond ? 'a' : 'b'`. The label mirrors
      // that same condition — see DYNAMIC_PAIRS.
      const dyn = icons.length === 1 && typeof icons[0] === 'object' ? icons[0].cond : null;
      if (!dyn && icons.some((i) => typeof i === 'object')) {
        return skip('dynamic icon among several');
      }
      if (dyn) {
        const pairKey = `${dyn.consequent.value}|${dyn.alternate.value}`;
        const pair = DYNAMIC_PAIRS[pairKey];
        const same = DYNAMIC_SAME[pairKey];
        if (!pair && !same) {
          unmapped.set(pairKey, (unmapped.get(pairKey) ?? 0) + 1);
          return skip('dynamic icon name');
        }
        if (!hasTranslate(path)) {
          noTranslate.add(file);
          return skip('no useTranslation in scope');
        }
        // The test is spliced from the ORIGINAL source rather than printed
        // from the AST, so an expression like `(a ? b : c) === d` keeps its
        // exact text and parenthesisation.
        const test = src.slice(dyn.test.start, dyn.test.end);
        let label;
        if (same) {
          usedKeys.add(same);
          label = `t('a11y.${same}')`;
        } else {
          usedKeys.add(pair[0]); usedKeys.add(pair[1]);
          label = `${test} ? t('a11y.${pair[0]}') : t('a11y.${pair[1]}')`;
        }
        edits.push({
          at: opening.name.end,
          text: ` accessibilityRole="button" accessibilityLabel={${label}}`,
        });
        return;
      }

      // Several icons inside one button (e.g. a play/pause pair) means the
      // label depends on state — a human has to write it.
      const distinct = [...new Set(icons)];
      if (distinct.length > 1) return skip('multiple different icons');

      const key = ICON_KEYS[distinct[0]];
      if (!key) {
        unmapped.set(distinct[0], (unmapped.get(distinct[0]) ?? 0) + 1);
        return;
      }

      if (!hasTranslate(path)) {
        noTranslate.add(file);
        return skip('no useTranslation in scope');
      }

      usedKeys.add(key);
      edits.push({
        at: opening.name.end,
        text: ` accessibilityRole="button" accessibilityLabel={t('a11y.${key}')}`,
      });
    },
  });

  if (edits.length === 0) continue;

  // Highest offset first: splicing back-to-front means every remaining offset
  // still points at the same character it did when the AST was built.
  edits.sort((a, b) => b.at - a.at);
  let out = src;
  for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.at);

  // Re-parse the RESULT. If the edit produced anything that isn't valid TSX,
  // the file is left untouched. This is the check that would have caught the
  // regex disaster before it wrote 89 files.
  try {
    parse(out, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  } catch (err) {
    console.error(`REJECTED (would not parse) ${file}: ${err.message}`);
    continue;
  }

  if (apply) writeFileSync(file, out, 'utf8');
  filesChanged++;
  inserted += edits.length;
}

console.log(`${apply ? 'APPLIED' : 'DRY RUN'} — ${inserted} labels across ${filesChanged} files\n`);

console.log('skipped (need a human):');
for (const [r, n] of [...skipped].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${r}`);

if (unmapped.size) {
  console.log('\nunmapped icons (add to ICON_KEYS to cover):');
  for (const [i, n] of [...unmapped].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${i}`);
}

if (noTranslate.size) {
  console.log('\nfiles needing useTranslation() added by hand:');
  for (const f of noTranslate) console.log(`  ${f}`);
}

console.log('\ni18n keys used (all must exist in lib/i18n.ts for all 10 langs):');
console.log([...usedKeys].sort().map((k) => `a11y.${k}`).join(', '));
