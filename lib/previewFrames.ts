// Which moments of a video Explore's moving-stills preview shows — see
// components/PreviewStills.tsx. Pure, so it can be tested without a phone.

/**
 * `count` whole-second timestamps spread evenly over the part of the video that
 * plays (its trim window, when it has one), each at the middle of its slice — so
 * no frame lands on a fade-in at 0s or on the final frame.
 *
 * Whole seconds on purpose: every viewer then asks Cloudflare for the same URLs
 * and hits its cache, instead of generating near-duplicates.
 *
 * Returns [] when the length is unknown. Cloudflare answers a timestamp past the
 * end with HTTP 400 ("thumbnail timestamp exceeds duration of video"), so a guess
 * is worse than showing the poster. Stored durations are whole seconds and can
 * run a fraction past the real end (705 for a 704.6s stream); the last slice's
 * midpoint sits at 87.5% of the span, well clear of that.
 */
export function previewFrameTimes(
  durationSec: number | null | undefined,
  trimStartSec: number | null | undefined,
  trimEndSec: number | null | undefined,
  count: number,
): number[] {
  const dur = typeof durationSec === 'number' ? durationSec : NaN;
  if (!Number.isFinite(dur) || dur <= 0 || !(count > 0)) return [];
  const start = Math.min(Math.max(trimStartSec ?? 0, 0), dur);
  const end = Math.min(Math.max(trimEndSec ?? dur, start), dur);
  const span = end - start;
  if (span < 1) return [];
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    // Never before the trim start: flooring a fractional start would step back
    // into footage the poster cut.
    const t = Math.max(Math.ceil(start), Math.floor(start + (span * (i + 0.5)) / count));
    if (times[times.length - 1] !== t) times.push(t);
  }
  return times;
}
