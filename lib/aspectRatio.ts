// Post format options (Instagram-style). Stored as a string on posts.aspect_ratio.
//   1:1 square · 4:5 portrait  (1.91:1 landscape dropped for photos — too narrow)
// Single photos: square, or tall. Written as the literal 4:5 rather than 'full'
// because for the photos people actually post they are the SAME THING —
// clampFeedAspect floors at 4/5, so a portrait phone photo (3:4, 9:16) resolves
// to exactly 4:5 anyway. Naming the ratio is honest about where it lands, and
// spares a resolution step that only ever returned the same number.
export const IMAGE_FORMATS = ['1:1', '4:5'] as const;
export const VIDEO_FORMATS = ['1:1', '4:5', '1.91:1'] as const;

// The shapes a slideshow can be CROPPED to. Not a frame the user picks up front
// — a slideshow starts as 'full', meaning it takes the shape of its first slide
// and every slide is shown whole inside it. These are the choices offered once
// somebody decides to crop.
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
 * The fit a slide gets when nobody has chosen one for it: FITTED.
 *
 * A slideshow is a set of photos that were never taken to match each other, so
 * the honest default is to show each one whole, at the proportions it was shot
 * at. Filling by default cropped photos the poster never asked to have cropped,
 * and then needed a Fill/Fit control to undo — a switch that only existed to
 * take back a decision nothing had asked for.
 *
 * Cropping is now the only thing that fills, which is what cropping means.
 */
export function defaultFitFor(_format?: string | null): SlideFit {
  return 'contain';
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
