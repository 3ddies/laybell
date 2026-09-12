// When each caption on a video shows — the timing half of the 1.0.3 video
// editor. Pure (no React Native), so it is tested in plain Node.
//
// Times are SECONDS on the published video's own clock: the same clock the
// players report through onProgress. A caption without `start` shows from the
// beginning, one without `end` until the end — so every caption posted before
// 1.0.3, which has neither, shows for the whole video exactly as it always did.

export type StickerTiming = { start?: number | null; end?: number | null };

/** Within this of a window edge counts as the edge ("from the start", "to the end"). */
export const EDGE_SEC = 0.25;
/** The shortest a timed caption may show. Anything briefer reads as a flicker. */
export const MIN_SHOW_SEC = 0.5;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Whether a caption shows at `t` seconds. `end` is exclusive. */
export function showsAt(s: StickerTiming, t: number): boolean {
  if (isNum(s.start) && t < s.start) return false;
  if (isNum(s.end) && t >= s.end) return false;
  return true;
}

/** A caption with any timing at all. */
export function isTimed(s: StickerTiming): boolean {
  return isNum(s.start) || isNum(s.end);
}

/**
 * Which captions show at `t`, as a string that changes only when one enters or
 * leaves — `|0|2|` means the first and third. Players report every ~250 ms; a
 * renderer compares this instead of re-rendering on every tick.
 */
export function visibleKey(stickers: StickerTiming[], t: number): string {
  let key = '|';
  for (let i = 0; i < stickers.length; i++) if (showsAt(stickers[i], t)) key += `${i}|`;
  return key;
}

/**
 * A caption's window inside the video's playable window [winStart, winEnd]:
 * clamped into it, snapped to an edge within EDGE_SEC, and at least MIN_SHOW_SEC
 * long (or the whole window, when that is shorter).
 */
export function resolveWindow(s: StickerTiming, winStart: number, winEnd: number): { start: number; end: number } {
  const lo = Math.min(winStart, winEnd);
  const hi = Math.max(winStart, winEnd);
  const clamp = (v: number) => Math.min(Math.max(v, lo), hi);
  let a = clamp(isNum(s.start) ? s.start : lo);
  let b = clamp(isNum(s.end) ? s.end : hi);
  if (b < a) [a, b] = [b, a];
  if (a - lo <= EDGE_SEC) a = lo;
  if (hi - b <= EDGE_SEC) b = hi;
  const min = Math.min(MIN_SHOW_SEC, hi - lo);
  if (b - a < min) {
    b = Math.min(hi, a + min);
    a = Math.max(lo, b - min);
  }
  return { start: a, end: b };
}

/**
 * Split an editor's captions for publishing.
 *  - always: shown for the whole window. Saved WITHOUT timing to posts.captions,
 *    which every app version already renders.
 *  - timed: shown for part of it. Saved to posts.timed_captions, which only 1.0.3
 *    and later read — an older app shows the video without them, rather than
 *    every caption at once.
 * Times are clamped into the window; a side that reaches the window's edge is
 * left open, so a caption "from the start" never depends on the first tick
 * landing exactly on the trim point.
 */
export function splitForPublish<T extends StickerTiming>(
  stickers: T[], winStart: number, winEnd: number,
): { always: T[]; timed: T[] } {
  const always: T[] = [];
  const timed: T[] = [];
  for (const out of timingForPublish(stickers, winStart, winEnd)) (isTimed(out) ? timed : always).push(out);
  return { always, timed };
}

/**
 * Every caption with its timing as publish stores it — splitForPublish's rule —
 * kept in the editor's order, for captions that are stored together whether timed
 * or not (a horizontal clip's band captions, lib/bandCaptions).
 */
export function timingForPublish<T extends StickerTiming>(stickers: T[], winStart: number, winEnd: number): T[] {
  const lo = Math.min(winStart, winEnd);
  const hi = Math.max(winStart, winEnd);
  return stickers.map((s) => {
    const { start, end } = resolveWindow(s, lo, hi);
    const out = { ...s };
    delete out.start;
    delete out.end;
    if (start > lo) out.start = round2(start);
    if (end < hi) out.end = round2(end);
    return out;
  });
}

/**
 * Re-base timed captions onto a file that was PHYSICALLY cut to begin at
 * `offset` seconds. The upload queue cuts when the native trimmer is in the
 * build, and that published video's clock starts at 0 rather than at the trim.
 */
export function shiftTimes<T extends StickerTiming>(stickers: T[], offset: number): T[] {
  if (!(offset > 0)) return stickers;
  return stickers.map((s) => {
    const out = { ...s };
    if (isNum(s.start)) out.start = round2(Math.max(0, s.start - offset));
    if (isNum(s.end)) out.end = round2(Math.max(0, s.end - offset));
    return out;
  });
}

/**
 * A caption added while the playhead sits at `t` shows from there to the end —
 * unless the playhead is at the very start, or too near the end to show at all.
 */
export function timingForNew(t: number, winStart: number, winEnd: number): { start?: number } {
  return t - winStart > EDGE_SEC && winEnd - t >= MIN_SHOW_SEC ? { start: round2(t) } : {};
}

/** A post's captions and timed captions as one list. Either may be absent or malformed. */
export function postStickers<T>(captions: unknown, timed: unknown): T[] {
  const a = Array.isArray(captions) ? (captions as T[]) : [];
  const b = Array.isArray(timed) ? (timed as T[]) : [];
  if (!b.length) return a;
  return a.length ? [...a, ...b] : b;
}

/** Whether a post carries any caption at all. */
export function hasPostStickers(captions: unknown, timed: unknown): boolean {
  return (Array.isArray(captions) && captions.length > 0) || (Array.isArray(timed) && timed.length > 0);
}
