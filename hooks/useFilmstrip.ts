import { useEffect, useState } from 'react';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { cfStreamFrameUrl, isCfStreamHls } from '../lib/cast';

// A strip of frames across part of a clip — the studio's timeline and its cover
// picker. Decoded ONE AT A TIME at low quality (eight concurrent native decodes of
// a long 4K clip spike memory), each frame landing as it is made, so a strip fills
// left to right; a frame that fails leaves its cell to the poster.
//
// Kept per clip and window for the session, so a second strip of the same clip —
// the cover picker, after the timeline made its frames — paints at once.
//
// `uri` must be a file the app can read. A camera-roll URI decodes nothing on iOS
// (hooks/usePlayableClip explains), which is why the old cover sheet, handed the
// picked URI, never showed a frame.
//
// A POSTED Cloudflare Stream video (re-editing a live post) is not decoded at all:
// its frames are already on the CDN, one thumbnail URL per cell. Thumbnails are
// not billed as delivery, so a strip of them costs nothing.

type Frames = (string | null)[];
const cache = new Map<string, Frames>();
const CACHE_MAX = 8;
// Tall enough for the cover picker's box, small enough to arrive quickly.
const CDN_FRAME_H = 240;

function remember(key: string, frames: Frames) {
  cache.delete(key);
  cache.set(key, frames);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

const secAt = (i: number, count: number, windowStart: number, windowEnd: number) =>
  windowStart + ((i + 0.5) / count) * (windowEnd - windowStart);

function cdnFrames(uri: string, windowStart: number, windowEnd: number, count: number): Frames {
  return Array.from({ length: count }, (_, i) => cfStreamFrameUrl(uri, secAt(i, count, windowStart, windowEnd), CDN_FRAME_H));
}

export function useFilmstrip(uri: string | null, windowStart: number, windowEnd: number, count: number): Frames {
  const key = uri && windowEnd > windowStart ? `${count}|${windowStart}|${windowEnd}|${uri}` : null;
  const cdn = !!uri && isCfStreamHls(uri);
  const [frames, setFrames] = useState<Frames>(() => {
    if (key && uri && cdn) return cdnFrames(uri, windowStart, windowEnd, count);
    return (key && cache.get(key)) || new Array(count).fill(null);
  });

  useEffect(() => {
    if (!key || !uri) { setFrames(new Array(count).fill(null)); return; }
    if (cdn) { setFrames(cdnFrames(uri, windowStart, windowEnd, count)); return; }
    const out: Frames = [...(cache.get(key) ?? new Array(count).fill(null))];
    setFrames([...out]);
    if (out.every(Boolean)) return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < count; i++) {
        if (cancelled) return;
        if (out[i]) continue;
        const sec = secAt(i, count, windowStart, windowEnd);
        try {
          const r = await VideoThumbnails.getThumbnailAsync(uri, { time: Math.max(0, Math.floor(sec * 1000)), quality: 0.2 });
          if (cancelled) return;
          out[i] = r.uri;
          remember(key, [...out]);
          setFrames([...out]);
        } catch {
          // The poster stays in that cell — a missing frame never blanks the strip.
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return frames;
}
