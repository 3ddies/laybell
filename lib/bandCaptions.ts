import { isTimed } from './stickerTiming';

// Captions on a HORIZONTAL video — the video studio's text, placed in the black
// letterbox bands above and below the clip while it is watched upright (owner
// request, 2026-09-11). Watched sideways the clip fills the screen and they don't
// show. Pure (no React Native), so it is tested in plain Node.
//
// A band caption is the same sticker object a vertical clip's captions are, plus
// `band`, with its `y` measured INSIDE that band's zone — 0 the zone's top, 1 its
// bottom — rather than down the whole screen. Phones leave different amounts of
// black around a landscape clip, so a caption resting against the picture on one
// phone must still clear it on another: every surface maps `y` into the zone the
// phone at hand has, and shrinks a caption that doesn't fit (fitInZone).
//
// STORED in posts.timed_captions, timed or not — never posts.captions. Every app
// before 1.0.3 draws posts.captions over the FEED card of any video, so a band
// caption there would land on the picture. Those apps draw the band bubbles
// (posts.top_caption / bottom_caption) instead, so publishing also writes one bubble
// per band from the whole-video captions (legacyBandCaption) — and an app that
// knows band captions draws them, never those bubbles, for the same post.

export type Band = 'top' | 'bottom';
export type CaptionZoneKind = Band | 'screen';
export type CaptionZone = { band: number; videoH: number; top: number; bottom: number; usable: number };

/** A band caption as the studio makes one (structurally a components/StickerLayer Sticker). */
export type BandCaptionSticker = {
  id: string;
  text: string;
  band: Band;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  font?: 'classic' | 'bold' | 'typewriter' | 'serif' | 'neon';
  color?: string;
  bg?: 'none' | 'pill' | 'soft' | 'boxy';
  size?: number;
  emoji?: boolean;
  start?: number;
  end?: number;
};

/** The band bubble apps before 1.0.3 draw: posts.top_caption / bottom_caption. */
export type LegacyBandCaption = { text: string; bg: string; color: string; y: number; scale: number };

/** Too little black to hold a caption: the zone stays empty. */
export const MIN_ZONE = 34;
export const LEGACY_SCALE_MIN = 0.5;
export const LEGACY_SCALE_MAX = 2.5;
// A tap this close outside a zone still lands in it.
const TAP_SLOP = 16;
// The bubble's text size at scale 1 (components/TopCaption).
const LEGACY_FONT = 17;
// A caption's text size when it names none — the studio's default.
const DEFAULT_SIZE = 26;
// The 'soft' caption background (components/StickerLayer).
const SOFT_BG = 'rgba(0,0,0,0.45)';
// The bubble for older apps (legacyBandCaption): at most this many rows, and roughly
// how many narrow characters fit a row at its default size on a 375 pt phone — the
// top band's bubble may be 86% of the screen wide, the bottom's 66% (components/TopCaption).
const LEGACY_MAX_ROWS = 2;
const LEGACY_ROW_UNITS: Record<Band, number> = { top: 26, bottom: 20 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => (Number.isFinite(v) ? clamp(v, 0, 1) : 0.5);
const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Where a caption may live on the upright reel, per zone kind:
 *  - 'top':    (landscape clips) the top letterbox band — below the back button,
 *    ABOVE the RotateHint (parked at band - 52).
 *  - 'bottom': (landscape clips) the bottom band — just under the video, ABOVE the
 *    reel's bottom UI: the meta block (username + caption + song card) and the
 *    scrub bar own the last ~240px of the screen.
 *  - 'screen': (VERTICAL clips, which fill the screen edge to edge) anywhere over
 *    the video between those same two protected strips.
 */
export function captionZone(kind: CaptionZoneKind, ratio: number, screenW: number, screenH: number): CaptionZone {
  const videoH = screenW / ratio;
  const band = Math.max(0, (screenH - videoH) / 2);
  if (kind === 'top') {
    const top = 74;               // clear of the status bar + floating back button
    const bottom = band - 52 - 10; // the RotateHint pill sits at band - 52
    return { band, videoH, top, bottom, usable: Math.max(0, bottom - top) };
  }
  if (kind === 'screen') {
    const top = 74;
    const bottom = screenH - 240;
    return { band, videoH, top, bottom, usable: Math.max(0, bottom - top) };
  }
  const top = band + videoH + 8;
  const bottom = screenH - 240;
  return { band, videoH, top, bottom, usable: Math.max(0, bottom - top) };
}

/** A landscape clip's two caption zones on this screen; null where there's too little black. */
export function bandZones(ratio: number, screenW: number, screenH: number): Record<Band, CaptionZone | null> {
  const top = captionZone('top', ratio, screenW, screenH);
  const bottom = captionZone('bottom', ratio, screenW, screenH);
  return { top: top.usable >= MIN_ZONE ? top : null, bottom: bottom.usable >= MIN_ZONE ? bottom : null };
}

// A saved video's bands have no app around them — no back button, rotate pill or
// reel controls — so they keep only a margin from the frame's edge and a gap from
// the picture, as fractions of the frame's width.
const EXPORT_EDGE = 0.06;
const EXPORT_GAP = 0.03;

/**
 * A band's caption zone in a SAVED upright frame of `frameW` × `frameH` (in the units
 * the captions are sized in): the clip across the frame's width, centred, and the
 * band above or below it less the margins. A caption keeps its place inside its
 * band, so it sits where it did in the app, relative to the band.
 */
export function exportBandZone(band: Band, ratio: number, frameW: number, frameH: number): CaptionZone {
  const videoH = frameW / ratio;
  const bandH = Math.max(0, (frameH - videoH) / 2);
  const edge = frameW * EXPORT_EDGE;
  const gap = frameW * EXPORT_GAP;
  const top = band === 'top' ? edge : bandH + videoH + gap;
  const bottom = band === 'top' ? bandH - gap : frameH - edge;
  return { band: bandH, videoH, top, bottom, usable: Math.max(0, bottom - top) };
}

/** The band a tap at `yPx` lands in, if any. */
export function bandAt(yPx: number, ratio: number, screenW: number, screenH: number): Band | null {
  const zones = bandZones(ratio, screenW, screenH);
  for (const band of ['top', 'bottom'] as const) {
    const zone = zones[band];
    if (zone && yPx >= zone.top - TAP_SLOP && yPx <= zone.bottom + TAP_SLOP) return band;
  }
  return null;
}

/** The band a caption centred at `yPx` belongs in: the one on its side of the picture, or the only one there is. */
export function nearestBand(yPx: number, ratio: number, screenW: number, screenH: number): Band | null {
  const zones = bandZones(ratio, screenW, screenH);
  // The picture sits in the middle of the screen.
  const side: Band = yPx < screenH / 2 ? 'top' : 'bottom';
  if (zones[side]) return side;
  const other: Band = side === 'top' ? 'bottom' : 'top';
  return zones[other] ? other : null;
}

/**
 * A caption kept whole inside a zone: shrunk until it fits (never below
 * `minScale`), then moved in from the zone's edges and the screen's sides. `w`/`h`
 * are its size before scaling and rotation; 0 — not measured yet — keeps just its
 * centre inside.
 */
export function fitInZone(
  p: { cx: number; cy: number; w: number; h: number; scale: number; rotation: number },
  zone: { top: number; bottom: number; usable: number },
  screenW: number,
  minScale = 0.4,
): { cx: number; cy: number; scale: number } {
  const rad = ((Number.isFinite(p.rotation) ? p.rotation : 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const w = Math.max(0, p.w || 0);
  const h = Math.max(0, p.h || 0);
  // The rotated caption's bounding box, before scaling.
  const boxW = w * cos + h * sin;
  const boxH = w * sin + h * cos;
  const room = Math.max(0, zone.usable);
  let scale = p.scale > 0 ? p.scale : 1;
  if (boxH > 0 && boxH * scale > room) scale = Math.max(minScale, room / boxH);
  if (boxW > 0 && boxW * scale > screenW) scale = Math.max(minScale, screenW / boxW);
  const halfH = (boxH * scale) / 2;
  const halfW = (boxW * scale) / 2;
  const cy = 2 * halfH >= room ? zone.top + room / 2 : clamp(p.cy, zone.top + halfH, zone.top + room - halfH);
  const cx = 2 * halfW >= screenW ? screenW / 2 : clamp(p.cx, halfW, screenW - halfW);
  return { cx, cy, scale };
}

/**
 * Where a band caption's centre sits on this screen, as a fraction of its height. A
 * band this screen has no room for hands its captions to the other band, so they
 * can still be seen and edited.
 */
export function bandToScreenY(band: Band, y: number, ratio: number, screenW: number, screenH: number): number {
  let zone = captionZone(band, ratio, screenW, screenH);
  if (zone.usable < MIN_ZONE) {
    const other = captionZone(band === 'top' ? 'bottom' : 'top', ratio, screenW, screenH);
    if (other.usable >= MIN_ZONE) zone = other;
  }
  return (zone.top + clamp01(y) * Math.max(0, zone.usable)) / screenH;
}

/** A caption centred at `yNorm` down the screen, as a band caption's band and y. */
export function screenToBand(yNorm: number, ratio: number, screenW: number, screenH: number): { band: Band; y: number } {
  const yPx = yNorm * screenH;
  const band = nearestBand(yPx, ratio, screenW, screenH) ?? (yPx < screenH / 2 ? 'top' : 'bottom');
  const zone = captionZone(band, ratio, screenW, screenH);
  return { band, y: zone.usable > 0 ? round3(clamp01((yPx - zone.top) / zone.usable)) : 0.5 };
}

export function isBandSticker<T>(s: T): s is T & { band: Band } {
  const band = (s as { band?: unknown } | null | undefined)?.band;
  return band === 'top' || band === 'bottom';
}

/** Whether a post's timed captions hold band captions. */
export function hasBandStickers(timedCaptions: unknown): boolean {
  return Array.isArray(timedCaptions) && timedCaptions.some(isBandSticker);
}

// Perceived luminance → black or white text over a coloured pill — the rule
// components/StickerLayer dresses a 'pill' or 'boxy' caption with.
function contrastOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#FFFFFF';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#0A0A0A' : '#FFFFFF';
}

/** Loose runtime guard for a band bubble read back off a post row or a draft. */
export function asLegacyBandCaption(v: unknown): LegacyBandCaption | null {
  const d = v as LegacyBandCaption | null;
  if (!d || typeof d !== 'object' || typeof d.text !== 'string' || !d.text.trim()) return null;
  return {
    text: d.text,
    bg: typeof d.bg === 'string' ? d.bg : '#FFFFFF',
    color: typeof d.color === 'string' ? d.color : '#111111',
    y: typeof d.y === 'number' ? Math.min(1, Math.max(0, d.y)) : 0.35,
    scale: typeof d.scale === 'number' ? Math.min(LEGACY_SCALE_MAX, Math.max(LEGACY_SCALE_MIN, d.scale)) : 1,
  };
}

// A character's rough width in narrow-character units: CJK, kana, Hangul, fullwidth
// forms and emoji take two.
function charUnits(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  const wide = cp > 0xffff
    || (cp >= 0x1100 && cp <= 0x115f)
    || (cp >= 0x2e80 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe4f)
    || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6);
  return wide ? 2 : 1;
}

function textUnits(text: string): number {
  let n = 0;
  for (const ch of text) n += charUnits(ch);
  return n;
}

// The start of `text` that fits `max` units, ending in an ellipsis (one unit).
function cutToUnits(text: string, max: number): string {
  let out = '';
  let n = 0;
  for (const ch of text) {
    const w = charUnits(ch);
    if (n + w > max - 1) break;
    out += ch;
    n += w;
  }
  return `${out.trimEnd()}…`;
}

// Lines laid into at most LEGACY_MAX_ROWS wrapped rows of `perRow` units. A line
// that doesn't fit — or the last that does, when more follow — is cut short with an
// ellipsis.
function fitRows(lines: string[], perRow: number): string {
  const rows: string[] = [];
  let left = LEGACY_MAX_ROWS;
  for (let i = 0; i < lines.length && left > 0; i++) {
    const need = Math.max(1, Math.ceil(textUnits(lines[i]) / perRow));
    const more = i < lines.length - 1;
    if (need < left || (need === left && !more)) {
      rows.push(lines[i]);
      left -= need;
    } else {
      rows.push(cutToUnits(lines[i], left * perRow));
      left = 0;
    }
  }
  return rows.join('\n');
}

type PlacedCaption = {
  text: string;
  y: number;
  scale?: number;
  color?: string;
  bg?: string;
  size?: number;
  band?: Band;
  start?: number | null;
  end?: number | null;
};

/**
 * One band's captions as the single bubble apps before 1.0.3 can draw: the ones
 * that show for the whole video (a timed one would show throughout there), top to
 * bottom as the lines of one bubble, dressed like the first. Null when there are
 * none.
 *
 * Those apps neither shrink nor clip the bubble, so it's kept small enough never to
 * reach the picture on any phone: no bigger than its default size, and at most two
 * rows, anything longer cut short with an ellipsis. Two rows (about 58 pt) fit the
 * smallest band those apps draw at all (34 pt) plus the 62 pt they keep clear above
 * the picture — even with a row more than the estimate.
 */
export function legacyBandCaption(stickers: PlacedCaption[], band: Band): LegacyBandCaption | null {
  const whole = stickers
    .filter((s) => s.band === band && !isTimed(s) && typeof s.text === 'string' && s.text.trim().length > 0)
    .sort((a, b) => a.y - b.y);
  if (!whole.length) return null;
  const first = whole[0];
  const color = typeof first.color === 'string' ? first.color : '#FFFFFF';
  const filled = first.bg === 'pill' || first.bg === 'boxy';
  const size = (typeof first.size === 'number' && first.size > 0 ? first.size : DEFAULT_SIZE)
    * (typeof first.scale === 'number' && first.scale > 0 ? first.scale : 1);
  return {
    text: fitRows(whole.flatMap((s) => s.text.split('\n').map((l) => l.trim()).filter(Boolean)), LEGACY_ROW_UNITS[band]),
    bg: filled ? color : first.bg === 'soft' ? SOFT_BG : 'transparent',
    color: filled ? contrastOn(color) : color,
    y: round3(clamp01(first.y)),
    scale: round2(clamp(size / LEGACY_FONT, LEGACY_SCALE_MIN, 1)),
  };
}

/**
 * A post's or draft's band bubbles from before 1.0.3's band captions, as band
 * captions the studio can edit: centred, each bubble's colours and text size kept.
 */
export function bandStickersFromLegacy(top: unknown, bottom: unknown): BandCaptionSticker[] {
  const out: BandCaptionSticker[] = [];
  for (const [band, value] of [['top', top], ['bottom', bottom]] as const) {
    const d = asLegacyBandCaption(value);
    if (!d) continue;
    const base = {
      id: `band-${band}`, text: d.text.trim(), band,
      x: 0.5, y: d.y, scale: 1, rotation: 0,
      font: 'bold' as const, size: Math.round(LEGACY_FONT * d.scale),
    };
    if (d.bg === 'transparent') out.push({ ...base, bg: 'none', color: d.color });
    else if (d.bg === SOFT_BG) out.push({ ...base, bg: 'soft', color: d.color });
    else out.push({ ...base, bg: 'boxy', color: d.bg });
  }
  return out;
}
