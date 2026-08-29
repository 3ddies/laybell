// Post format options (Instagram-style). Stored as a string on posts.aspect_ratio.
//   1:1 square · 4:5 portrait  (1.91:1 landscape dropped for photos — too narrow)
// Single photos: square, or tall. Written as the literal 4:5 rather than 'full'
// because for the photos people actually post they are the SAME THING —
// clampFeedAspect floors at 4/5, so a portrait phone photo (3:4, 9:16) resolves
// to exactly 4:5 anyway. Naming the ratio is honest about where it lands, and
// spares a resolution step that only ever returned the same number.
export const IMAGE_FORMATS = ['1:1', '4:5'] as const;
export const VIDEO_FORMATS = ['1:1', '4:5', '1.91:1'] as const;

// Slideshow frame options. '1:1' and '4:5' are literal ratios; 'full' and
// 'mixed' are MODES, resolved to a real ratio from the media at share time —
// they never reach the database, because a carousel has exactly one frame and
// posts.aspect_ratio has to be a number the feed can lay out from.
//
// The two modes differ in what happens to slides that do not match that frame,
// not in the frame itself:
//   full  — frame takes slide 1's own shape, and the rest are FILLED (cropped).
//   mixed — same frame, but every slide is FITTED (letterboxed) instead, so a
//           set of different shapes publishes with nothing cut off.
// Either default can be overridden per slide on the Arrange screen.
// 'full' is deliberately NOT offered. For the photos people actually post it
// lands on 4:5 anyway — clampFeedAspect floors at 4/5 — so it was a third button
// that mostly repeated the second. isAutoFormat still understands it, because
// drafts saved before this change can still carry it.
export const SLIDESHOW_FORMATS = ['1:1', '4:5', 'mixed'] as const;
export type SlideFit = 'cover' | 'contain';

/** Formats with no ratio in them — resolved from the media itself. */
export function isAutoFormat(format?: string | null): boolean {
  return format === 'full' || format === 'mixed';
}

/** The fit a slide gets when the user has not chosen one for it. */
export function defaultFitFor(format?: string | null): SlideFit {
  return format === 'mixed' ? 'contain' : 'cover';
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
