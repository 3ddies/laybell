// Post format options (Instagram-style). Stored as a string on posts.aspect_ratio.
//   1:1 square · 4:5 portrait  (1.91:1 landscape dropped for photos — too narrow)
// Single photos: square, or tall. Written as the literal 4:5 rather than 'full'
// because for the photos people actually post they are the SAME THING —
// clampFeedAspect floors at 4/5, so a portrait phone photo (3:4, 9:16) resolves
// to exactly 4:5 anyway. Naming the ratio is honest about where it lands, and
// spares a resolution step that only ever returned the same number.
export const IMAGE_FORMATS = ['1:1', '4:5'] as const;
export const VIDEO_FORMATS = ['1:1', '4:5', '1.91:1'] as const;

// The shapes a slideshow can be CROPPED to. A slideshow starts at 4:5 — a
// portrait frame, so a landscape photo fits inside it with bars above and below
// rather than down the sides. These are the choices offered once somebody
// decides to crop; 'full' (Original) is the third, and means no crop at all.
//
// 'full' and 'mixed' are MODES rather than ratios, resolved against the media at
// share time; they never reach the database, because a carousel has exactly one
// frame and posts.aspect_ratio has to be a number the feed can lay out from.
// 'mixed' is legacy — a set is mixed now simply by being left alone.
export const SLIDESHOW_FORMATS = ['1:1', '4:5'] as const;
export type SlideFit = 'cover' | 'contain';

/** Formats with no ratio in them — resolved from the media itself. */
export function isAutoFormat(format?: string | null): boolean {
  return format === 'full' || format === 'mixed';
}

/**
 * The fit a slide gets when nobody has chosen one for it.
 *
 * ⚠️ NEVER SIDE BARS. The two kinds of letterboxing are not equally acceptable:
 * bars above and below a wide photo read as the photo BEING wide, but bars down
 * the sides of a tall one read as the app failing to fill its own frame.
 *
 * Which one you get is decided entirely by whether the slide is wider or
 * narrower than the frame. So anything WIDER may fit — its bars land top and
 * bottom, which is fine — and anything NARROWER must fill, because fitting it
 * would put bars down the sides. A tall photo is cropped by default for that
 * reason, and the poster reframes which part of it survives.
 *
 * A slide with no dimensions fills, since a bar cannot be ruled out without
 * knowing the shape.
 */
export function defaultSlideFit(
  frameAspect: number,
  media?: { width?: number | null; height?: number | null } | null,
): SlideFit {
  const w = media?.width ?? 0;
  const h = media?.height ?? 0;
  if (!(w > 0 && h > 0)) return 'cover';
  return w / h < frameAspect ? 'cover' : 'contain';
}

/**
 * The shape a slide OCCUPIES: what it was cropped to, or its own proportions
 * when it was left alone. `shape` is the composer's per-slide crop choice —
 * absent or 'full' means uncropped.
 */
export function slideAspect(
  s?: { width?: number | null; height?: number | null; shape?: string | null } | null,
): number {
  if (s?.shape && !isAutoFormat(s.shape)) return aspectToNumber(s.shape, 1);
  const w = s?.width ?? 0;
  const h = s?.height ?? 0;
  return w > 0 && h > 0 ? w / h : 1;
}

/**
 * The ONE frame a carousel is laid out in, measured across the WHOLE set.
 *
 * Sized to the TALLEST slide, which is what makes per-slide shapes possible at
 * all: every other slide is then square-or-wider relative to it, so it can be
 * shown whole with bars above and below — never down the sides, which
 * defaultSlideFit explains is the one kind of letterboxing this app refuses. A
 * set of mixed shapes therefore needs no cropping to share a frame, and a set
 * cropped uniformly (all square, say) gets a frame of exactly that shape with no
 * bars at all.
 *
 * Derived from the SET and never from whichever slide was edited last. Cropping
 * one photo used to set the post's frame directly, and every OTHER photo in the
 * post — none of which had been touched — was silently re-cropped to fit it.
 */
export function slideshowCanvasAspect(
  slides: { width?: number | null; height?: number | null; shape?: string | null }[],
): number {
  let tallest = Infinity;
  for (const s of slides ?? []) {
    const a = slideAspect(s);
    if (isFinite(a) && a > 0) tallest = Math.min(tallest, a);
  }
  if (!isFinite(tallest)) return 1;
  return clampFeedAspect(tallest);
}

/**
 * The largest centred rect of `aspect` inside a w×h image.
 *
 * This is the crop a slide gets when a shape was chosen but never hand-framed —
 * and it is not an approximation of what the composer showed, it is the same
 * thing: MediaCropper opens at scale 1, which covers its box centred, so this
 * reproduces its untouched state exactly. Without it a slide cycled to Square
 * and left alone published UNCROPPED, having been previewed as a square.
 */
export function centeredCrop(
  w: number, h: number, aspect: number,
): { originX: number; originY: number; width: number; height: number } | null {
  if (!(w > 0 && h > 0 && aspect > 0)) return null;
  let cw = w;
  let ch = w / aspect;
  if (ch > h) { ch = h; cw = h * aspect; }
  return {
    originX: Math.round((w - cw) / 2),
    originY: Math.round((h - ch) / 2),
    width: Math.round(cw),
    height: Math.round(ch),
  };
}

/**
 * How a slide meets the carousel frame, given the shape it occupies.
 *
 * With a canvas sized by slideshowCanvasAspect nothing is narrower than the
 * frame, so this answers 'contain' for every slide in a normal set. It still has
 * to ask, because clampFeedAspect floors the canvas at 4:5 — a 9:16 photo is
 * taller than any frame the feed allows, and that one really must fill.
 */
export function slideFitFor(
  s: { width?: number | null; height?: number | null; shape?: string | null },
  frameAspect: number,
): SlideFit {
  return slideAspect(s) < frameAspect ? 'cover' : 'contain';
}

/**
 * The numeric frame ratio for a post. An auto format takes it from the media —
 * for a slideshow, from the FIRST slide, since a carousel has one frame.
 *
 * Clamped to the feed's bounds: a 9:16 phone photo would otherwise publish
 * taller than the screen it is being read on.
 */
export function resolveFrameAspect(
  format: string,
  media?: { width?: number | null; height?: number | null } | null,
): number {
  if (!isAutoFormat(format)) return aspectToNumber(format, 1);
  const w = media?.width ?? 0;
  const h = media?.height ?? 0;
  if (!(w > 0 && h > 0)) return 1;
  return clampFeedAspect(w / h);
}

// Numeric width/height ratio for React Native's `aspectRatio` style.
// Accepts preset labels ("9:16"), any "W:H" string, or a plain numeric string
// (e.g. "0.8") so media can be stored at its exact native aspect ratio.
export function aspectToNumber(ratio?: string | null, fallback = 1): number {
  if (!ratio) return fallback;
  if (ratio === '9:16') return 9 / 16;
  if (ratio === '16:9') return 16 / 9;
  if (ratio === '1:1') return 1;
  if (ratio.includes(':')) {
    const [w, h] = ratio.split(':').map(Number);
    return h > 0 ? w / h : fallback;
  }
  const n = parseFloat(ratio);
  return isFinite(n) && n > 0 ? n : fallback;
}

// Instagram-style feed bounds: portrait no taller than 4:5, landscape no wider
// than 1.91:1. Keeps posts filling the width without becoming extreme.
export function clampFeedAspect(ratio: number): number {
  return Math.min(Math.max(ratio, 4 / 5), 1.91);
}

// Video allows wider (cinematic) landscape than photos so horizontally-recorded
// clips keep their true frame; still floored/ceilinged to avoid extreme slivers.
export function clampVideoAspect(ratio: number): number {
  return Math.min(Math.max(ratio, 4 / 5), 2.4);
}

// [width, height] for ImagePicker's crop `aspect`.
export function aspectToArray(ratio: string): [number, number] {
  const [w, h] = ratio.split(':').map(Number);
  return [w || 1, h || 1];
}

export function defaultFormatFor(type: 'image' | 'video' | 'audio'): string {
  if (type === 'video') return '4:5';
  return '1:1';
}
