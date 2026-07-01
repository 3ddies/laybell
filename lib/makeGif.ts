// Create an animated GIF from a video segment — fully on-device, no native
// module or server. Frames are pulled with expo-video-thumbnails, downscaled +
// re-encoded to small JPEGs with expo-image-manipulator, decoded to RGBA with
// jpeg-js, then quantized and GIF-encoded with gifenc. Deliberately conservative
// (short clip, capped frames, ~240px wide) so it stays responsive in Hermes.

import * as VideoThumbnails from 'expo-video-thumbnails';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
// Pure-JS libs; required (not imported) to avoid missing-type friction.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { GIFEncoder, quantize, applyPalette } = require('gifenc');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const jpeg = require('jpeg-js');

export type GifResult = { uri: string; width: number; height: number };
export const GIF_MAX_FRAMES = 24;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64LOOKUP = (() => { const l = new Uint8Array(256); for (let i = 0; i < B64.length; i++) l[B64.charCodeAt(i)] = i; return l; })();

function b64ToBytes(b64: string): Uint8Array {
  let len = b64.length;
  while (len > 0 && b64[len - 1] === '=') len--;
  const out = new Uint8Array((len * 3) >> 2);
  let p = 0;
  for (let i = 0; i + 1 < len; i += 4) {
    const a = B64LOOKUP[b64.charCodeAt(i)];
    const b = B64LOOKUP[b64.charCodeAt(i + 1)];
    const c = i + 2 < len ? B64LOOKUP[b64.charCodeAt(i + 2)] : 0;
    const d = i + 3 < len ? B64LOOKUP[b64.charCodeAt(i + 3)] : 0;
    out[p++] = (a << 2) | (b >> 4);
    if (i + 2 < len) out[p++] = ((b & 15) << 4) | (c >> 2);
    if (i + 3 < len) out[p++] = ((c & 3) << 6) | d;
  }
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let out = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b1 = bytes[i];
    const b2 = i + 1 < len ? bytes[i + 1] : 0;
    const b3 = i + 2 < len ? bytes[i + 2] : 0;
    out += B64[b1 >> 2];
    out += B64[((b1 & 3) << 4) | (b2 >> 4)];
    out += i + 1 < len ? B64[((b2 & 15) << 2) | (b3 >> 6)] : '=';
    out += i + 2 < len ? B64[b3 & 63] : '=';
  }
  return out;
}

export async function makeGifFromVideo(
  videoUri: string,
  opts: { startMs: number; durationMs: number; fps?: number; width?: number },
  onProgress?: (fraction: number) => void,
): Promise<GifResult> {
  const fps = opts.fps ?? 8;
  const width = opts.width ?? 240;
  const frames = Math.max(2, Math.min(GIF_MAX_FRAMES, Math.round((opts.durationMs / 1000) * fps)));
  const delay = Math.round(1000 / fps);
  const span = frames > 1 ? opts.durationMs / (frames - 1) : 0;

  const gif = GIFEncoder();
  let gifW = width, gifH = 0;

  for (let i = 0; i < frames; i++) {
    const timeMs = Math.round(opts.startMs + span * i);
    const thumb = await VideoThumbnails.getThumbnailAsync(videoUri, { time: timeMs, quality: 0.7 });
    const small = await ImageManipulator.manipulateAsync(
      thumb.uri,
      [{ resize: { width } }],
      { compress: 0.92, format: ImageManipulator.SaveFormat.JPEG, base64: true },
    );
    const { data, width: fw, height: fh } = jpeg.decode(b64ToBytes(small.base64 as string), { useTArray: true, formatAsRGBA: true });
    gifW = fw; gifH = fh;
    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);
    gif.writeFrame(index, fw, fh, { palette, delay });
    // Drop the temp frame files as we go so the cache doesn't balloon.
    FileSystem.deleteAsync(thumb.uri, { idempotent: true }).catch(() => {});
    if (small.uri) FileSystem.deleteAsync(small.uri, { idempotent: true }).catch(() => {});
    onProgress?.((i + 1) / frames);
  }

  gif.finish();
  const out = `${FileSystem.cacheDirectory}gif_${Date.now()}.gif`;
  await FileSystem.writeAsStringAsync(out, bytesToB64(gif.bytes()), { encoding: FileSystem.EncodingType.Base64 });
  return { uri: out, width: gifW, height: gifH };
}
