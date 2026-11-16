// Derive a punchy accent colour from album artwork, so surfaces like the album
// Play button can take on the cover's own colour (the way Apple Music / Spotify
// tint their headers). Skia is already a shipped dependency, so this needs no
// new native module. Everything is defensive: if decoding or reading the image
// fails for any reason the hook simply returns null and the caller keeps its
// default colour — there is never a crash or a blank button.
import { useEffect, useState } from 'react';
import { useImage, ColorType, AlphaType, type SkImage } from '@shopify/react-native-skia';

export type CoverAccent = { bg: string; fg: string };

// ---- pure colour maths (no Skia) — exported so it can be unit-tested alone ----

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = (((g - b) / d) % 6 + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  const s = max === 0 ? 0 : d / max;
  return [h, s, max];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const toHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => clamp255(v).toString(16).padStart(2, '0')).join('');

// WCAG relative luminance — used to choose readable text over the accent.
function luminance(r: number, g: number, b: number): number {
  const lin = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/**
 * Pick an accent that reads as "from this artwork": bin the saturated pixels by
 * hue, take the heaviest hue's saturation-weighted mean, then normalise it into
 * a button-friendly saturation/value band so even dark or washed-out covers give
 * a confident chip. Falls back to the value-weighted overall average for grey
 * artwork, and to null when there is nothing usable. `px` is tightly-packed
 * RGBA; `count` is the pixel count (px.length / 4).
 */
export function accentFromPixels(px: Uint8Array | Uint8ClampedArray | number[], count: number): CoverAccent | null {
  if (!px || count <= 0) return null;
  const BINS = 12;
  const bins = Array.from({ length: BINS }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  let gw = 0, gr = 0, gg = 0, gb = 0; // value-weighted overall fallback
  let sampled = 0;
  const step = Math.max(1, Math.floor(count / 4096)); // sample ~4096 pixels evenly
  for (let p = 0; p < count; p += step) {
    const o = p * 4;
    if ((px[o + 3] ?? 0) < 128) continue; // skip transparent
    const r = px[o], g = px[o + 1], b = px[o + 2];
    const [h, s, v] = rgbToHsv(r, g, b);
    if (v < 0.12 || v > 0.98) continue; // skip near-black / near-white
    sampled++;
    gw += v; gr += r * v; gg += g * v; gb += b * v;
    if (s < 0.18) continue; // too grey to vote on a hue
    const w = s * s * (0.4 + 0.6 * v); // favour saturated and lit pixels
    const bi = Math.min(BINS - 1, Math.floor(h / (360 / BINS)));
    bins[bi].w += w; bins[bi].r += r * w; bins[bi].g += g * w; bins[bi].b += b * w;
  }
  if (sampled === 0) return null;

  let best = bins[0];
  for (const bin of bins) if (bin.w > best.w) best = bin;

  let r: number, g: number, b: number;
  if (best.w > 0) { r = best.r / best.w; g = best.g / best.w; b = best.b / best.w; }
  else { r = gr / gw; g = gg / gw; b = gb / gw; }

  // Normalise into a punchy, legible band but keep the cover's hue.
  let [h, s, v] = rgbToHsv(r, g, b);
  if (s > 0.05) s = Math.max(0.5, Math.min(0.92, s));
  v = Math.max(0.52, Math.min(0.86, v));
  [r, g, b] = hsvToRgb(h, s, v);

  return { bg: toHex(r, g, b), fg: luminance(r, g, b) > 0.6 ? '#121212' : '#ffffff' };
}

// ---- Skia wrapper ----

function readAccent(img: SkImage): CoverAccent | null {
  try {
    const w = img.width();
    const h = img.height();
    if (!w || !h) return null;
    const px = img.readPixels(0, 0, {
      width: w, height: h, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul,
    }) as Uint8Array | null;
    if (!px) return null;
    return accentFromPixels(px, w * h);
  } catch {
    return null;
  }
}

/**
 * Returns a `{ bg, fg }` accent for the given image URI, or null while loading /
 * on any failure. Decodes off the UI with Skia's loader; the heavy pixel read
 * runs once per resolved image.
 */
export function useCoverAccent(uri?: string | null): CoverAccent | null {
  const img = useImage(uri ?? null);
  const [accent, setAccent] = useState<CoverAccent | null>(null);
  useEffect(() => {
    if (!img) { setAccent(null); return; } // clears while the next cover loads
    setAccent(readAccent(img));
  }, [img]);
  return accent;
}
