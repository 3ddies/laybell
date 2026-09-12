// The plan for saving a FINISHED video to the camera roll: the frame it is written
// at, where the reel viewer's screen sits inside that frame, and which captions show
// when — as full-frame overlay images the native exporter lays over the clip
// (modules/laybell-video-export). Pure, so it is tested in plain Node.
//
// Captions are placed against the SCREEN, and the reel viewer shows a vertical video
// filling it (contentFit cover). So the part of the video a viewer sees is the
// largest screen-shaped rectangle centred in the frame, and a caption drawn at a
// screen position lands at the same place inside that rectangle.

import { showsAt, type StickerTiming } from './stickerTiming';

/** The longest side of a saved video. 1080p-class, the same as the upload. */
export const EXPORT_MAX_DIMENSION = 1920;
/** Stretches shorter than this fold into the one before — a frame or two, not a flicker. */
export const MIN_SEGMENT_SEC = 0.05;
/**
 * The frame a horizontal clip with band captions is saved in: upright 9:16,
 * 1080p-class — the clip across its middle and the captions in the bands, how the
 * app shows it upright (lib/bandCaptions exportBandZone).
 */
export const UPRIGHT_FRAME: Size = { width: 1080, height: 1920 };

export type Size = { width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };

/** A stretch of the exported clip, in seconds from its first frame, and the captions showing through it. */
export type CaptionSegment<T> = { start: number; end: number; stickers: T[] };

const even = (n: number) => Math.max(2, 2 * Math.floor(n / 2));
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The saved video's frame: the clip's display size (rotation applied), scaled down
 * so its longest side is at most `maxDimension`, in whole even pixels — H.264
 * encoders want even dimensions. Never scaled up.
 */
export function outputSize(video: Size, maxDimension = EXPORT_MAX_DIMENSION): Size {
  const w = Math.max(2, video.width);
  const h = Math.max(2, video.height);
  const scale = Math.min(1, maxDimension / Math.max(w, h));
  return { width: even(w * scale), height: even(h * scale) };
}

/**
 * Where the screen a caption was placed on sits inside the video frame: the largest
 * rectangle of the screen's shape, centred — what the reel viewer shows of a
 * vertical video filling the screen.
 */
export function screenRectInFrame(frame: Size, screen: Size): Rect {
  const shape = screen.width / screen.height;
  let width = frame.width;
  let height = width / shape;
  if (height > frame.height) {
    height = frame.height;
    width = height * shape;
  }
  return { x: (frame.width - width) / 2, y: (frame.height - height) / 2, width, height };
}

/**
 * The exported clip cut into stretches where the same captions show, with every
 * stretch that shows none left out. Times come in on the SOURCE clock (the window
 * [windowStart, windowEnd] is the part that gets saved) and go out relative to the
 * window's start. Adjacent stretches with the same captions merge, so a caption set
 * that does not change is one image.
 */
export function captionSegments<T extends StickerTiming>(
  stickers: T[],
  windowStart: number,
  windowEnd: number,
): CaptionSegment<T>[] {
  const duration = windowEnd - windowStart;
  if (!(duration > 0) || !stickers.length) return [];

  const cuts = new Set<number>([0, round3(duration)]);
  for (const s of stickers) {
    for (const t of [s.start, s.end]) {
      if (typeof t !== 'number' || !Number.isFinite(t)) continue;
      const rel = round3(t - windowStart);
      if (rel > 0 && rel < duration) cuts.add(rel);
    }
  }
  const times = [...cuts].sort((a, b) => a - b);

  const out: CaptionSegment<T>[] = [];
  for (let i = 0; i < times.length - 1; i++) {
    const a = times[i];
    const b = times[i + 1];
    const prev = out[out.length - 1];
    if (b - a < MIN_SEGMENT_SEC) {
      if (prev && prev.end === a) prev.end = b;
      continue;
    }
    const visible = stickers.filter((s) => showsAt(s, windowStart + (a + b) / 2));
    if (!visible.length) continue;
    if (prev && prev.end === a && sameStickers(prev.stickers, visible)) prev.end = b;
    else out.push({ start: a, end: b, stickers: visible });
  }
  return out;
}

function sameStickers<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}
