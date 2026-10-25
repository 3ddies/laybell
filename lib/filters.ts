import type { ViewStyle } from 'react-native';

// Instagram-style story filters, built entirely from React Native's GPU `filter` style
// prop (New Architecture, RN ≥0.76) — no image baking, no native dep, no new files. The
// SAME css array is applied to the media in the editor preview AND by the story viewer
// (stored as a `{ kind:'filter' }` layer in the story's stickers jsonb), so a filtered
// story is portable and costs nothing to render.
//
// GOTCHAS (see node_modules/react-native/.../processFilter.js):
//   • If ANY primitive is invalid, RN drops the WHOLE filter (nothing renders). So every
//     value here must be valid: non-negative numbers for brightness/contrast/grayscale/
//     saturate/sepia/invert/opacity/blur.
//   • `hueRotate` as a bare number is REJECTED unless it's 0 — it must be a 'deg'/'rad'
//     STRING (e.g. '-12deg'). Everything else is a plain number.

export type FilterKey =
  | 'original' | 'vivid' | 'warm' | 'cool' | 'mono'
  | 'noir' | 'sepia' | 'fade' | 'dramatic' | 'dreamy';

export type FilterCss = NonNullable<ViewStyle['filter']>;

// `tint` is a best-effort translucent color overlay to approximate the look on the LIVE
// camera feed (expo-camera exposes no frames, so the real filter can't render live — it bakes
// on capture). Only color-CAST looks can be faked by an overlay; desaturation/saturation/
// contrast (mono/noir/vivid/dramatic) can't, so those have no tint (the chip + the captured
// result still show the true filter).
export type StoryFilter = { key: FilterKey; name: string; css: FilterCss; tint?: string };

// Names are kept as untranslated proper nouns (as Instagram keeps "Clarendon", "Juno").
// Values are deliberately BOLD so each look is unmistakable at a glance.
export const STORY_FILTERS: StoryFilter[] = [
  { key: 'original', name: 'Original', css: [] },
  { key: 'vivid',    name: 'Vivid',    css: [{ saturate: 2 }, { contrast: 1.3 }, { brightness: 1.04 }] },
  { key: 'warm',     name: 'Warm',     css: [{ sepia: 0.5 }, { saturate: 1.5 }, { brightness: 1.08 }, { contrast: 1.05 }], tint: 'rgba(255,158,58,0.16)' },
  { key: 'cool',     name: 'Cool',     css: [{ hueRotate: '-25deg' }, { saturate: 1.35 }, { brightness: 1.05 }, { contrast: 1.05 }], tint: 'rgba(56,138,255,0.15)' },
  { key: 'mono',     name: 'Mono',     css: [{ grayscale: 1 }, { contrast: 1.25 }] },
  { key: 'noir',     name: 'Noir',     css: [{ grayscale: 1 }, { contrast: 1.8 }, { brightness: 0.8 }] },
  { key: 'sepia',    name: 'Sepia',    css: [{ sepia: 1 }, { contrast: 1.15 }, { brightness: 1.05 }], tint: 'rgba(142,102,56,0.26)' },
  { key: 'fade',     name: 'Fade',     css: [{ contrast: 0.7 }, { saturate: 0.6 }, { brightness: 1.2 }], tint: 'rgba(233,231,226,0.20)' },
  { key: 'dramatic', name: 'Dramatic', css: [{ contrast: 1.7 }, { saturate: 1.4 }, { brightness: 0.9 }] },
  { key: 'dreamy',   name: 'Dreamy',   css: [{ brightness: 1.25 }, { saturate: 1.3 }, { contrast: 0.8 }], tint: 'rgba(255,239,229,0.15)' },
];

const BY_KEY: Record<string, StoryFilter> = Object.fromEntries(STORY_FILTERS.map((f) => [f.key, f]));

export function isFilterKey(v: unknown): v is FilterKey {
  return typeof v === 'string' && v in BY_KEY;
}

// The css for a stored/selected filter, or undefined for 'original' / unknown (so callers
// can spread `filterStyle(key)` and get no filter when there's nothing to apply).
export function filterCss(key: string | null | undefined): FilterCss | undefined {
  if (!key || key === 'original') return undefined;
  const css = BY_KEY[key]?.css;
  return css && css.length ? css : undefined;
}

// The best-effort live-camera overlay color for a filter, or undefined when the look can't be
// approximated by a color cast (the real filter still bakes on capture). See StoryFilter.tint.
export function liveTint(key: string | null | undefined): string | undefined {
  if (!key || key === 'original') return undefined;
  return BY_KEY[key]?.tint;
}

// ── Skia color matrix ────────────────────────────────────────────────────────
// RN's `filter` style doesn't apply color effects on iOS, so filters are rendered/baked
// with Skia instead (lib/filterSkia). Every preset is AFFINE in RGB, so the css composes
// into ONE 4×5 Skia color matrix (W3C filter math → Skia's `ColorFilter.MakeMatrix`). This
// is pure JS (no Skia import here) so it's safe to use anywhere.
type Mat3 = number[]; // length 9, row-major
type Vec3 = [number, number, number];
const ID3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const LR = 0.2126, LG = 0.7152, LB = 0.0722;
const mul3 = (a: Mat3, b: Mat3): Mat3 => {
  const r: Mat3 = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
};
const mulV3 = (m: Mat3, v: Vec3): Vec3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const diag3 = (k: number): Mat3 => [k, 0, 0, 0, k, 0, 0, 0, k];
const satMat = (s: number): Mat3 => [LR + s * (1 - LR), LG * (1 - s), LB * (1 - s), LR * (1 - s), LG + s * (1 - LG), LB * (1 - s), LR * (1 - s), LG * (1 - s), LB + s * (1 - LB)];
const sepMat = (a: number): Mat3 => { const S: Mat3 = [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131]; return S.map((v, i) => ID3[i] * (1 - a) + v * a); };
const hueMat = (deg: number): Mat3 => { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); return [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928, 0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283, 0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072]; };
function parseVal(name: string, raw: unknown): number | null {
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string') return null;
  if (name === 'hueRotate') { const m = /(-?\d*\.?\d+)\s*(deg|rad)?/.exec(raw); if (!m) return null; const n = Number(m[1]); return m[2] === 'rad' ? (n * 180) / Math.PI : n; }
  const m = /(-?\d*\.?\d+)\s*%?/.exec(raw); if (!m) return null; let n = Number(m[1]); if (raw.includes('%')) n /= 100; return n;
}

// Compose the css into out = M·in + O (channels 0..255), in list order.
function buildTransform(css: FilterCss): { m: Mat3; o: Vec3 } {
  let m = ID3.slice();
  let o: Vec3 = [0, 0, 0];
  const after = (nm: Mat3, no: Vec3) => { m = mul3(nm, m); o = mulV3(nm, o); o[0] += no[0]; o[1] += no[1]; o[2] += no[2]; };
  if (Array.isArray(css)) {
    for (const fn of css) {
      const [name, raw] = Object.entries(fn)[0] ?? [];
      if (!name) continue;
      const v = parseVal(name, raw);
      if (v == null) continue;
      switch (name) {
        case 'brightness': after(diag3(v), [0, 0, 0]); break;
        case 'contrast': { const off = (0.5 - 0.5 * v) * 255; after(diag3(v), [off, off, off]); break; }
        case 'saturate': after(satMat(v), [0, 0, 0]); break;
        case 'grayscale': after(satMat(1 - v), [0, 0, 0]); break;
        case 'sepia': after(sepMat(v), [0, 0, 0]); break;
        case 'hueRotate': after(hueMat(v), [0, 0, 0]); break;
        case 'invert': { const k = 1 - 2 * v; after(diag3(k), [v * 255, v * 255, v * 255]); break; }
        default: break; // blur/opacity: not expressible as a color matrix — skipped
      }
    }
  }
  return { m, o };
}

// The 4×5 (20-element, row-major RGBA) Skia color matrix for a filter, or null for
// 'original'/unknown. The bias column is normalized to 0..1 (Skia works in 0..1).
export function skiaColorMatrix(key: string | null | undefined): number[] | null {
  if (!key || key === 'original') return null;
  const preset = BY_KEY[key];
  if (!preset || !preset.css.length) return null;
  const { m, o } = buildTransform(preset.css);
  return [
    m[0], m[1], m[2], 0, o[0] / 255,
    m[3], m[4], m[5], 0, o[1] / 255,
    m[6], m[7], m[8], 0, o[2] / 255,
    0, 0, 0, 1, 0,
  ];
}
